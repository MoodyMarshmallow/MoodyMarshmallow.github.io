import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createServer } from 'vite';
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
      await mkdir(join(root, 'public', 'writing', slug), { recursive: true });
      await writeFile(join(root, 'public', 'writing', slug, 'demo.mp4'), 'video fixture');
      await writeFile(join(directory, 'index.html'), post(title, date, `<p>${words(count)}</p><video><source src="/writing/${slug}/demo.mp4"><a href="./demo.mp4">Download video</a></video>`));
    };
    await savePost('older', 'Older post', '2026-08-01', 225);
    await savePost('latest', 'Latest &amp; greatest', '2026-09-15', 226);
    const generate = async (base: string) => {
      await build({ root, configFile: false, base, logLevel: 'silent', plugins: [writingMetadataPlugin()] });
      return readFile(join(root, 'dist', 'index.html'), 'utf8');
    };
    for (const base of ['/', '/Personal-Website/', './']) {
      const home = await generate(base);
      expect(home).toContain('Latest &amp; greatest');
      expect(home).toContain('August 2026');
      expect(home).toContain('September 2026');
      expect(home.indexOf('Latest &amp; greatest')).toBeLessThan(home.indexOf('Older post'));
      const href = home.match(/href="([^"]*writing\/latest-greatest\/[^"\s]*)"/)?.[1];
      expect(href).toBeDefined();
      const deployedBase = base === './' ? '/nested/' : base;
      expect(new URL(href!, `https://example.test${deployedBase}`).pathname).toBe(`${deployedBase}writing/latest-greatest/`);
      const latest = await readFile(join(root, 'dist/writing/latest-greatest/index.html'), 'utf8');
      expect(latest).toContain('2 min read');
      expect(latest).not.toContain('Stale browser title');
      expect(latest).toContain('<title>Latest &amp; greatest');
      const download = latest.match(/href="([^"]*demo\.mp4)"/)?.[1];
      expect(download).toBeDefined();
      expect(new URL(download!, `https://example.test${deployedBase}writing/latest-greatest/`).pathname).toBe(`${deployedBase}writing/latest/demo.mp4`);
    }
    await savePost('latest', 'Revised title', '2026-07-01', 900);
    await savePost('new-post', 'Newly added post', '2026-10-01', 100);
    const updatedHome = await generate('/');
    expect(updatedHome).toContain('Revised title');
    expect(updatedHome).not.toContain('Latest &amp; greatest');
    expect(updatedHome.indexOf('Newly added post')).toBeLessThan(updatedHome.indexOf('Older post'));
    expect(updatedHome.indexOf('Older post')).toBeLessThan(updatedHome.indexOf('Revised title'));
    expect(updatedHome).toContain('writing/revised-title/');
    expect(updatedHome).not.toContain('writing/latest-greatest/');
    expect(await readFile(join(root, 'dist/writing/revised-title/index.html'), 'utf8')).toContain('4 min read');
    expect(await readFile(join(root, 'dist/writing/newly-added-post/index.html'), 'utf8')).toContain('1 min read');
  });

  test('serves title-derived routes in development after a title edit', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'website-writing-dev-')));
    fixtures.push(root);
    await writeFile(join(root, 'index.html'), '<html><div data-writing-list></div></html>');
    const source = join(root, 'writing', 'source-folder');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'index.html'), post('Original title', '2026-09-15', '<p>Article content</p>'));
    const server = await createServer({ root, configFile: false, base: '/preview/', logLevel: 'silent', plugins: [writingMetadataPlugin()], server: { host: '127.0.0.1', port: 42873, strictPort: true } });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Expected a local TCP server');
      const url = `http://127.0.0.1:${address.port}/preview/`;
      const original = await fetch(`${url}writing/original-title/`);
      expect(original.status).toBe(200);
      expect(await original.text()).toContain('<title>Original title · Milo Shan</title>');
      await writeFile(join(source, 'index.html'), post('Renamed title', '2026-09-15', '<p>Article content</p>'));
      const renamed = await fetch(`${url}writing/renamed-title/`);
      expect(renamed.status).toBe(200);
      expect(await renamed.text()).toContain('<title>Renamed title · Milo Shan</title>');
      expect(await (await fetch(url)).text()).toContain('/preview/writing/renamed-title/');
    } finally {
      await server.close();
    }
  });

  test('rejects posts whose titles generate the same URL', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'website-writing-collision-')));
    fixtures.push(root);
    await writeFile(join(root, 'index.html'), '<html><div data-writing-list></div></html>');
    for (const [folder, title] of [['first', 'Same Title!'], ['second', 'Same title']]) {
      await mkdir(join(root, 'writing', folder), { recursive: true });
      await writeFile(join(root, 'writing', folder, 'index.html'), post(title, '2026-09-15', '<p>Content</p>'));
    }
    await expect(build({ root, configFile: false, logLevel: 'silent', plugins: [writingMetadataPlugin()] })).rejects.toThrow(/collision|duplicate|same.*URL/i);
  });
});
