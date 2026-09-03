import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { normalizeAsciiPreset } from './src/asciiPreset';

const publishedPresetPath = fileURLToPath(new URL('./src/publishedHomePreset.json', import.meta.url));
const temporaryPresetPath = `${publishedPresetPath}.tmp`;

function publishedPresetPlugin(): Plugin {
  return {
    name: 'published-home-preset',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__publish-home-preset', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }

        let body = '';
        let bodyTooLarge = false;
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          if (bodyTooLarge) return;
          body += chunk;
          if (body.length > 64 * 1024) {
            bodyTooLarge = true;
            response.statusCode = 413;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ published: false, error: 'Preset payload is too large.' }));
          }
        });
        request.on('end', async () => {
          if (bodyTooLarge) return;
          try {
            const preset = normalizeAsciiPreset(JSON.parse(body));
            if (!preset) throw new Error('Invalid ASCII preset.');
            await writeFile(temporaryPresetPath, `${JSON.stringify(preset, null, 2)}\n`, 'utf8');
            await rename(temporaryPresetPath, publishedPresetPath);
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ published: true }));
          } catch (error) {
            response.statusCode = 400;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
              published: false,
              error: error instanceof Error ? error.message : 'Unable to publish preset.',
            }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [publishedPresetPlugin()],
  build: {
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
});
