import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const distDirectory = join(process.cwd(), 'dist');
const forbiddenViewerArtifacts = /(?:^|[\\/])viewer(?:-[^/]+)?\.(?:html|js|css)$/i;

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
if (/viewer(?:-[^"']*)?\.(?:js|css|html)/i.test(indexHtml)) {
  throw new Error('Homepage production HTML references viewer-only output.');
}

console.log(`Production output OK: ${relativeFiles.length} files; homepage only.`);
