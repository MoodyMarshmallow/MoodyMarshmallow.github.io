import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const distDirectory = join(process.cwd(), 'dist');
const forbiddenViewerArtifacts = /(?:^|[\\/])viewer(?:-[^/]+)?\.(?:html|js|css)$/i;
const mediaExtensions = /\.(?:avif|gif|jpe?g|m4v|mp3|mp4|ogg|png|svg|wav|webm|webp)$/i;

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}

const files = await collectFiles(distDirectory);
const relativeFiles = files.map((file) => file.slice(distDirectory.length + 1));
if (!relativeFiles.includes('index.html')) {
  throw new Error('Production output is missing dist/index.html.');
}

const viewerArtifacts = relativeFiles.filter((file) => forbiddenViewerArtifacts.test(file));
if (viewerArtifacts.length > 0) {
  throw new Error(`Viewer artifacts must stay local-dev only: ${viewerArtifacts.join(', ')}`);
}

const indexHtml = await readFile(join(distDirectory, 'index.html'), 'utf8');
const generatedAsset = indexHtml.match(/(?:src|href)=["'](\/(?:[^"']+\/)?assets\/[^"']+)["']/i)?.[1];
if (!generatedAsset) throw new Error('Homepage production HTML is missing a generated asset URL.');
const basePath = generatedAsset.slice(0, generatedAsset.indexOf('assets/'));
const htmlFiles = relativeFiles.filter((file) => file.endsWith('.html'));
for (const htmlFile of htmlFiles) {
  const html = htmlFile === 'index.html'
    ? indexHtml
    : await readFile(join(distDirectory, htmlFile), 'utf8');
  if (/viewer(?:-[^"']*)?\.(?:js|css|html)/i.test(html)) {
    throw new Error(`Production HTML references viewer-only output: ${htmlFile}`);
  }
  if (/!\[\[[^\]]+\]\]/.test(html)) {
    throw new Error(`Production HTML contains an unresolved Obsidian embed: ${htmlFile}`);
  }
}

function localOutputPath(reference: string, sourceFile: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) || reference.startsWith('#')) return null;
  const sourceUrl = new URL(`https://production.invalid${basePath}${sourceFile}`);
  const resolved = new URL(reference, sourceUrl);
  if (!resolved.pathname.startsWith(basePath)) return null;
  const candidate = decodeURIComponent(resolved.pathname.slice(basePath.length)).replace(/^\/+|\/+$/g, '');
  if (!candidate) return 'index.html';
  if (relativeFiles.includes(candidate)) return candidate;
  if (relativeFiles.includes(`${candidate}/index.html`)) return `${candidate}/index.html`;
  return null;
}

const writingSection = indexHtml.match(/<section\b[^>]*\bid=["']writing["'][^>]*>[\s\S]*?<\/section>/i)?.[0];
if (!writingSection) throw new Error('Homepage production HTML is missing the Writing section.');

const writingLinks = [...writingSection.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .filter((reference) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference));
if (writingLinks.length === 0) throw new Error('Homepage Writing section has no local article links.');

const articleFiles = writingLinks.map((reference) => {
  const articleFile = localOutputPath(reference, 'index.html');
  if (!articleFile || !articleFile.endsWith('.html')) {
    throw new Error(`Homepage Writing link does not resolve to a generated article: ${reference}`);
  }
  return articleFile;
});

const mediaReferences = new Set<string>();
for (const articleFile of articleFiles) {
  const articleHtml = await readFile(join(distDirectory, articleFile), 'utf8');
  for (const match of articleHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    const reference = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) || reference.startsWith('#')) continue;
    if (!localOutputPath(reference, articleFile)) {
      throw new Error(`Article link does not resolve within the production base path: ${reference} (from ${articleFile})`);
    }
    if (mediaExtensions.test(reference.split(/[?#]/, 1)[0])) mediaReferences.add(`${articleFile}\u0000${reference}`);
  }
}
console.log(`Production output OK: ${relativeFiles.length} files; ${articleFiles.length} writing article(s), ${mediaReferences.size} media reference(s).`);
