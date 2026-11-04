// Bundles the background worker into one file with no node_modules dependency.
// The Next standalone output only carries what its own routes trace, so the
// worker can't rely on it. Runs inside the Docker build. See src/worker/index.ts.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const locale = ['en', 'kk', 'ru'].includes(process.env.NEXT_PUBLIC_APP_LOCALE)
  ? process.env.NEXT_PUBLIC_APP_LOCALE
  : 'en';

await build({
  entryPoints: [resolve(root, 'src/worker/index.ts')],
  outfile: resolve(root, 'build/worker/worker.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // Keeps `@/...` imports the same as in the app.
  tsconfig: resolve(root, 'tsconfig.json'),
  alias: {
    '@app-messages': resolve(root, `src/messages/${locale}.json`),
  },
  logLevel: 'info',
});
