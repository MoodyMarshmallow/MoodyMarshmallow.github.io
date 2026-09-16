import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep, posix } from 'node:path';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { Plugin, ResolvedConfig } from 'vite';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export interface PostMetadata {
  title: string;
  date: string;
  wordCount: number;
  readingMinutes: number;
}

const excludedText = new Set(['nav', 'aside', 'video', 'audio', 'script', 'style', 'template', 'noscript', 'svg', 'canvas']);
const textBoundaries = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'figcaption', 'pre', 'br', 'hr', 'tr', 'td', 'th']);
const isElement = (node: Node): node is Element => 'tagName' in node;
const attribute = (node: Element, name: string) => node.attrs.find((attr) => attr.name === name)?.value;
const hasClass = (node: Element, name: string) => attribute(node, 'class')?.split(/\s+/u).includes(name);

function find(node: Node, predicate: (element: Element) => boolean): Element | undefined {
  if (isElement(node) && predicate(node)) return node;
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
}

// Visit each text node once: nested paragraphs/lists must not multiply the count.
function textContent(node: Node, editorial = false): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (editorial && isElement(node) && (excludedText.has(node.tagName) || attribute(node, 'hidden') !== undefined || attribute(node, 'aria-hidden') === 'true')) return '';
  const text = 'childNodes' in node ? node.childNodes.map((child) => textContent(child, editorial)).join('') : '';
  return isElement(node) && textBoundaries.has(node.tagName) ? ` ${text} ` : text;
}

function metadataFromDocument(document: Node, sourcePath: string): PostMetadata {
  const fail = (message: string): never => { throw new Error(`${sourcePath}: ${message}`); };
  const article = find(document, (node) => node.tagName === 'article' && !!find(node, (child) => child.tagName === 'h1' && attribute(child, 'id') === 'post-title'));
  if (!article) return fail('Expected an article with h1#post-title.');
  const heading = find(article, (node) => node.tagName === 'h1' && attribute(node, 'id') === 'post-title')!;
  const header = find(article, (node) => node.tagName === 'header');
  const time = header && find(header, (node) => node.tagName === 'time' && attribute(node, 'datetime') !== undefined);
  const body = find(article, (node) => !!hasClass(node, 'writing-body'));
  const title = textContent(heading).replace(/\s+/gu, ' ').trim();
  const date = time && attribute(time, 'datetime');
  if (!title) return fail('Post title must not be empty.');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return fail('Expected a valid YYYY-MM-DD in header time[datetime].');
  if (!body) return fail('Expected .writing-body.');
  const wordCount = textContent(body, true).trim().split(/\s+/u).filter(Boolean).length;
  return { title, date, wordCount, readingMinutes: Math.max(1, Math.ceil(wordCount / 225)) };
}

export function extractPostMetadata(html: string, sourcePath = 'post'): PostMetadata {
  return metadataFromDocument(parse(html), sourcePath);
}

export function discoverPosts(root: string): string[] {
  const directory = resolve(root, 'writing');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(directory, entry.name, 'index.html'))
    .filter(existsSync)
    .sort();
}

export function titleToSlug(title: string): string {
  const slug = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
  if (!slug) throw new Error(`Post title cannot produce a URL slug: ${JSON.stringify(title)}`);
  return slug;
}

function postsWithRoutes(root: string) {
  const posts = discoverPosts(root).map((path) => {
    const metadata = extractPostMetadata(readFileSync(path, 'utf8'), path);
    return { path, ...metadata, sourceRoute: relative(root, path).split(sep).slice(0, -1).join('/'), route: `writing/${titleToSlug(metadata.title)}` };
  });
  const routes = new Map<string, string>();
  for (const post of posts) {
    for (const route of new Set([post.sourceRoute, post.route])) {
      const owner = routes.get(route);
      if (owner && owner !== post.path) throw new Error(`Writing route collision at /${route}/ between ${owner} and ${post.path}. Change a post title or source folder.`);
      routes.set(route, post.path);
    }
  }
  return posts;
}

const encodedRoute = (route: string) => route.split('/').map(encodeURIComponent).join('/');

// The source folder owns media even when the title changes the published URL.
function rewriteRelativeUrls(html: string, sourceRoute: string, route: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: Node) => {
    if (isElement(node)) {
      for (const attr of node.attrs) {
        if (!['href', 'src', 'poster'].includes(attr.name) || !attr.value || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/iu.test(attr.value)) continue;
        const location = node.sourceCodeLocation?.attrs?.[attr.name];
        if (!location) continue;
        const target = new URL(attr.value, `https://writing.invalid/${encodedRoute(sourceRoute)}/`);
        const path = posix.relative(`/${encodedRoute(route)}`, target.pathname) || './';
        const url = path + (target.pathname.endsWith('/') && !path.endsWith('/') ? '/' : '') + target.search + target.hash;
        edits.push({ start: location.startOffset, end: location.endOffset, content: `${attr.name}="${escapeHtml(url)}"` });
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(document);
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.content + html.slice(edit.end);
  return html;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

// Source locations let us replace generated content without reserializing authored HTML.
function replaceContents(html: string, replacements: Array<{ element: Element; content: string }>): string {
  const edits = replacements.map(({ element, content }) => {
    const location = element.sourceCodeLocation;
    if (!location?.startTag || !location.endTag) throw new Error(`Expected explicit opening and closing tags for ${element.tagName}.`);
    return { start: location.startTag.endOffset, end: location.endTag.startOffset, content };
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.content + html.slice(edit.end);
  return html;
}

function addSocialPreview(html: string, post: ReturnType<typeof postsWithRoutes>[number], publicBase: URL): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const head = find(document, (node) => node.tagName === 'head');
  if (!head?.sourceCodeLocation?.endTag) throw new Error(`${post.path}: Expected an explicit </head> for social metadata.`);
  const description = find(head, (node) => node.tagName === 'meta' && attribute(node, 'name')?.toLowerCase() === 'description');
  const body = find(document, (node) => !!hasClass(node, 'writing-body'));
  const image = body && find(body, (node) => node.tagName === 'img');
  const src = image && attribute(image, 'src');
  let imageUrl: URL | undefined;
  if (src) {
    // Leading-slash assets are site-root assets in Vite, including project-base builds.
    const target = src.startsWith('/') && !src.startsWith('//')
      ? new URL(src.slice(1), publicBase)
      : new URL(src, new URL(`${encodedRoute(post.sourceRoute)}/`, publicBase));
    if (target.protocol === 'https:') imageUrl = target;
  }
  const canonical = new URL(`${encodedRoute(post.route)}/`, publicBase).href;
  const tags = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeHtml(post.title)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(post.title)}">`,
  ];
  const descriptionText = description && attribute(description, 'content');
  if (descriptionText) {
    tags.push(`<meta property="og:description" content="${escapeHtml(descriptionText)}">`, `<meta name="twitter:description" content="${escapeHtml(descriptionText)}">`);
  }
  if (imageUrl) {
    const alt = escapeHtml(attribute(image!, 'alt') ?? '');
    tags.push(`<meta property="og:image" content="${escapeHtml(imageUrl.href)}">`, `<meta property="og:image:alt" content="${alt}">`, `<meta name="twitter:image" content="${escapeHtml(imageUrl.href)}">`, `<meta name="twitter:image:alt" content="${alt}">`);
  }
  const edits = [{ start: head.sourceCodeLocation.endTag.startOffset, end: head.sourceCodeLocation.endTag.startOffset, content: `  ${tags.join('\n    ')}\n  ` }];
  for (const node of head.childNodes) {
    if (!isElement(node)) continue;
    const socialMeta = node.tagName === 'meta' && [attribute(node, 'property'), attribute(node, 'name')].some((name) => /^(?:og|twitter):/iu.test(name ?? ''));
    const canonicalLink = node.tagName === 'link' && attribute(node, 'rel')?.toLowerCase().split(/\s+/u).includes('canonical');
    const location = node.sourceCodeLocation;
    if ((socialMeta || canonicalLink) && location) edits.push({ start: location.startOffset, end: location.endOffset, content: '' });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.content + html.slice(edit.end);
  return html;
}

export interface WritingMetadataOptions {
  /** Public deployment URL; a pathname supplies the base when Vite uses './'. */
  siteUrl?: string;
}

export function writingMetadataPlugin({ siteUrl = 'https://moodymarshmallow.github.io/' }: WritingMetadataOptions = {}): Plugin {
  let config: ResolvedConfig;
  const site = new URL(siteUrl);
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) throw new Error('Writing metadata siteUrl must be a public HTTPS URL without credentials, query, or fragment.');
  if (!site.pathname.endsWith('/')) site.pathname += '/';
  const routeUrl = (route: string) => (config.base === '' || config.base === './' ? './' : config.base) + encodedRoute(route) + '/';
  return {
    name: 'writing-metadata',
    config(userConfig) {
      const root = resolve(userConfig.root ?? process.cwd());
      return { build: { rollupOptions: { input: [resolve(root, 'index.html'), ...postsWithRoutes(root).map((post) => post.path)] } } };
    },
    configResolved(resolved) { config = resolved; },
    buildStart() {
      for (const path of discoverPosts(config.root)) this.addWatchFile(path);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) return next();
        try {
          const url = new URL(request.url ?? '/', 'http://writing.invalid');
          const base = server.config.base === './' || !server.config.base ? '/' : server.config.base;
          if (!url.pathname.startsWith(base)) return next();
          const path = decodeURIComponent(url.pathname.slice(base.length)).replace(/\/(?:index\.html)?$/u, '');
          const posts = postsWithRoutes(server.config.root);
          const post = posts.find((entry) => entry.route === path);
          if (!post) return next();
          if (!url.pathname.endsWith('/')) {
            response.statusCode = 302;
            response.setHeader('Location', base + encodedRoute(post.route) + '/' + url.search);
            response.end();
            return;
          }
          request.url = base + encodedRoute(post.sourceRoute) + '/index.html' + url.search;
          next();
        } catch (error) { next(error as Error); }
      });
      server.watcher.add(resolve(server.config.root, 'writing'));
      const reloadPosts = (path: string) => {
        const local = relative(server.config.root, path).split(sep).join('/');
        if (/^writing\/[^/]+\/index\.html$/u.test(local)) server.ws.send({ type: 'full-reload', path: '*' });
      };
      server.watcher.on('add', reloadPosts).on('change', reloadPosts).on('unlink', reloadPosts);
      server.httpServer?.once('close', () => {
        server.watcher.off('add', reloadPosts).off('change', reloadPosts).off('unlink', reloadPosts);
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const filename = resolve(context.filename);
        const document = parse(html, { sourceCodeLocationInfo: true });
        if (filename === resolve(config.root, 'index.html')) {
          const list = find(document, (node) => attribute(node, 'data-writing-list') !== undefined);
          if (!list) throw new Error('Homepage needs a [data-writing-list] element.');
          const posts = postsWithRoutes(config.root)
            .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
          const content = posts.map((post) => {
            const url = routeUrl(post.route);
            const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(post.date));
            return `\n          <article class="entry">\n            <h3><a href="${escapeHtml(url)}">${escapeHtml(post.title)}</a></h3>\n            <p class="entry-meta"><time datetime="${post.date}">${dateLabel}</time></p>\n          </article>`;
          }).join('') + '\n        ';
          return replaceContents(html, [{ element: list, content }]);
        }
        const routedPost = postsWithRoutes(config.root).find((post) => post.path === filename);
        if (!routedPost) return html;
        const post = metadataFromDocument(document, filename);
        const readingTime = find(document, (node) => attribute(node, 'data-reading-time') !== undefined);
        const title = find(document, (node) => node.tagName === 'title');
        if (!readingTime || !title) throw new Error(`${filename}: Expected <title> and [data-reading-time] markers.`);
        const updated = replaceContents(html, [
          { element: readingTime, content: `${post.readingMinutes} min read` },
          { element: title, content: `${escapeHtml(post.title)} · Milo Shan` },
        ]);
        const publicBase = new URL(config.base === '' || config.base === './' ? './' : config.base, site);
        return rewriteRelativeUrls(addSocialPreview(updated, routedPost, publicBase), routedPost.sourceRoute, routedPost.route);
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const post of postsWithRoutes(config.root)) {
          if (post.route === post.sourceRoute) continue;
          const source = `${post.sourceRoute}/index.html`;
          const asset = bundle[source];
          if (!asset || asset.type !== 'asset') throw new Error(`Missing generated article HTML: ${source}`);
          delete bundle[source];
          asset.fileName = `${post.route}/index.html`;
          bundle[asset.fileName] = asset;
        }
      },
    },
  };
}
