import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import pkg from './package.json' with { type: 'json' }

// In dev/preview the web app reaches the API same-origin at /api (run `npm run server` alongside).
const proxy = { '/api': 'http://localhost:8787' }
// Readable crash reports: with SENTRY_AUTH_TOKEN set, a build uploads its source maps to Sentry and then deletes them,
// so they're never served. Without it, maps are still built (hidden: no link in the code) and simply not uploaded.
const upload = !!process.env.SENTRY_AUTH_TOKEN

export default defineConfig({
  plugins: [react(), ...(upload ? [sentryVitePlugin({
    org: 'criox4', project: 'capacitor', authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: `plico@${pkg.version}` },
    sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
    telemetry: false,
  })] : [])],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { sourcemap: 'hidden' },
  server: { proxy }, preview: { proxy },
})
