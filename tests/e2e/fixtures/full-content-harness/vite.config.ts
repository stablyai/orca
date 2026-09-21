import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const repoRoot = resolve(import.meta.dirname, '../../../..')

// Same alias and plugins as the renderer target in electron.vite.config.ts, so
// the harness renders the real components with the real stylesheet.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  resolve: { alias: { '@': resolve(repoRoot, 'src/renderer/src') } },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(repoRoot, 'out-harness/full-content'),
    emptyOutDir: true
  }
})
