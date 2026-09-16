import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
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

export function writingMetadataPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'writing-metadata',
    config(userConfig) {
      const root = resolve(userConfig.root ?? process.cwd());
      return { build: { rollupOptions: { input: [resolve(root, 'index.html'), ...discoverPosts(root)] } } };
    },
    configResolved(resolved) { config = resolved; },
    buildStart() {
      for (const path of discoverPosts(config.root)) this.addWatchFile(path);
    },
    configureServer(server) {
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
          const posts = discoverPosts(config.root).map((path) => ({ path, ...extractPostMetadata(readFileSync(path, 'utf8'), path) }))
            .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
          const base = config.base === '' || config.base === './' ? './' : config.base;
          const content = posts.map((post) => {
            const url = base + relative(config.root, post.path).split(sep).slice(0, -1).map(encodeURIComponent).join('/') + '/';
            const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(post.date));
            return `\n          <article class="entry">\n            <h3><a href="${escapeHtml(url)}">${escapeHtml(post.title)}</a></h3>\n            <p class="entry-meta"><time datetime="${post.date}">${dateLabel}</time></p>\n          </article>`;
          }).join('') + '\n        ';
          return replaceContents(html, [{ element: list, content }]);
        }
        if (!discoverPosts(config.root).includes(filename)) return html;
        const post = metadataFromDocument(document, filename);
        const readingTime = find(document, (node) => attribute(node, 'data-reading-time') !== undefined);
        const title = find(document, (node) => node.tagName === 'title');
        if (!readingTime || !title) throw new Error(`${filename}: Expected <title> and [data-reading-time] markers.`);
        return replaceContents(html, [
          { element: readingTime, content: `${post.readingMinutes} min read` },
          { element: title, content: `${escapeHtml(post.title)} · Milo Shan` },
        ]);
      },
    },
  };
}
