import { markdownParserAliases } from './config/build-plugins/markdown-parser-exports'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createPdfjsViewerAssetsPlugin } from './config/build-plugins/pdfjs-viewer-assets'
import { createViteCacheRetentionPlugin } from './config/build-plugins/vite-cache-retention'
import { resolveBuildSourceCommit } from './config/scripts/build-source-commit.mjs'

export default defineConfig({
  root: resolve('src/renderer'),
  cacheDir: resolve('.cache/vite/web'),
  // Resolve assets relatively for reverse-proxy pairing prefixes such as /orca/web-index.html.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    createPdfjsViewerAssetsPlugin(),
    createViteCacheRetentionPlugin()
  ],
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true',
    ORCA_BUILD_COMMIT: JSON.stringify(resolveBuildSourceCommit())
  },
  resolve: {
    alias: {
      ...markdownParserAliases,
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve('src/renderer/web-index.html')
    }
  },
  worker: {
    format: 'es'
  }
})
