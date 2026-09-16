import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { extractPostMetadata, writingMetadataPlugin } from '../plugins/writingMetadata';

const fixtures: string[] = [];
const words = (count: number) => Array(count).fill('word').join(' ');
const post = (title: string, date: string, body: string) => `<!doctype html>
<html><head><title>Stale browser title</title></head><body>
<nav>Navigation is not article text</nav>
<article><header><h1 id="post-title">${title}</h1>
<p data-reading-time></p><time datetime="${date}">Stale displayed date</time></header>
<div class="writing-body">${body}</div></article></body></html>`;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('writing metadata', () => {
  test('reads the post title and counts editorial text exactly once', () => {
    const html = post('Test <em>&amp;</em> Post', '2026-09-15', `
      <p>${words(225)}</p>
      <ul><li>one<ul><li>two</li></ul></li></ul>
      <figure><img alt="This must not affect reading time"><figcaption>caption</figcaption></figure>
      <video><a href="demo.mp4">This fallback must not count</a></video>
      <script>These script words must not count</script>`);
    const metadata = extractPostMetadata(html, '/writing/example/index.html');
    expect(metadata.title).toBe('Test & Post');
    expect(metadata.date).toBe('2026-09-15');
    expect(metadata.wordCount).toBe(228);
    expect(metadata.readingMinutes).toBe(2);
  });

  test('calculates reading-time boundaries from the content', () => {
    for (const [count, minutes] of [[1, 1], [225, 1], [226, 2], [900, 4]]) {
      const metadata = extractPostMetadata(post('Title', '2026-09-15', `<p>${words(count)}</p>`), '/writing/test/index.html');
      expect(metadata.wordCount).toBe(count);
      expect(metadata.readingMinutes).toBe(minutes);
    }
  });

  test('generates listing and reading time from discovered posts, including edits and new files', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'website-writing-')));
    fixtures.push(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Home</title></head><body><section id="writing"><div class="entry-list" data-writing-list></div></section></body></html>');
    const savePost = async (slug: string, title: string, date: string, count: number) => {
      const directory = join(root, 'writing', slug);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'index.html'), post(title, date, `<p>${words(count)}</p>`));
    };
    await savePost('older', 'Older post', '2026-08-01', 225);
    await savePost('latest', 'Latest &amp; greatest', '2026-09-15', 226);
    const generate = async (base: string) => {
      await build({ root, configFile: false, base, publicDir: false, logLevel: 'silent', plugins: [writingMetadataPlugin()] });
      return readFile(join(root, 'dist', 'index.html'), 'utf8');
    };
    for (const base of ['/', '/Personal-Website/']) {
      const home = await generate(base);
      expect(home).toContain('Latest &amp; greatest');
      expect(home).toContain('August 2026');
      expect(home).toContain('September 2026');
      expect(home.indexOf('Latest &amp; greatest')).toBeLessThan(home.indexOf('Older post'));
      const href = home.match(/href="([^"]*writing\/latest\/[^"\s]*)"/)?.[1];
      expect(href).toBeDefined();
      expect(new URL(href!, `https://example.test${base}`).pathname).toBe(`${base}writing/latest/`);
      const latest = await readFile(join(root, 'dist/writing/latest/index.html'), 'utf8');
      expect(latest).toContain('2 min read');
      expect(latest).not.toContain('Stale browser title');
      expect(latest).toContain('<title>Latest &amp; greatest');
    }
    await savePost('latest', 'Revised title', '2026-07-01', 900);
    await savePost('new-post', 'Newly added post', '2026-10-01', 100);
    const updatedHome = await generate('/');
    expect(updatedHome).toContain('Revised title');
    expect(updatedHome).not.toContain('Latest &amp; greatest');
    expect(updatedHome.indexOf('Newly added post')).toBeLessThan(updatedHome.indexOf('Older post'));
    expect(updatedHome.indexOf('Older post')).toBeLessThan(updatedHome.indexOf('Revised title'));
    expect(await readFile(join(root, 'dist/writing/latest/index.html'), 'utf8')).toContain('4 min read');
    expect(await readFile(join(root, 'dist/writing/new-post/index.html'), 'utf8')).toContain('1 min read');
  });
});
