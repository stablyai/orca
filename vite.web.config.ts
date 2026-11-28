import { markdownParserAliases } from './config/build-plugins/markdown-parser-exports'
import { monacoEditorEsmAlias, toAliasList } from './config/build-plugins/monaco-editor-esm-alias'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createPdfjsViewerAssetsPlugin } from './config/build-plugins/pdfjs-viewer-assets'
import { createViteCacheRetentionPlugin } from './config/build-plugins/vite-cache-retention'
import {
  ignoreIneffectiveDynamicImport,
  RENDERER_CHUNK_SIZE_WARNING_LIMIT_KB
} from './config/build-plugins/rollup-warning-filter'
import { reactPluginOptions } from './config/build-plugins/react-compiler'
import { resolveBuildSourceCommit } from './config/scripts/build-identity/build-source-commit.mjs'

export default defineConfig({
  root: resolve('src/renderer'),
  cacheDir: resolve('.cache/vite/web'),
  // Resolve assets relatively for reverse-proxy pairing prefixes such as /orca/web-index.html.
  base: './',
  plugins: [
    react(reactPluginOptions()),
    tailwindcss(),
    createPdfjsViewerAssetsPlugin(),
    createViteCacheRetentionPlugin()
  ],
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true',
    ORCA_BUILD_COMMIT: JSON.stringify(resolveBuildSourceCommit())
  },
  resolve: {
    alias: toAliasList(
      {
        ...markdownParserAliases,
        // Pin the browser-safe UMD entry so an unpatched package.json cannot bundle lib/addon-ligatures.mjs (which imports node:diagnostics_channel).
        '@xterm/addon-ligatures': resolve(
          'node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js'
        ),
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      },
      monacoEditorEsmAlias
    )
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: RENDERER_CHUNK_SIZE_WARNING_LIMIT_KB,
    rollupOptions: {
      input: resolve('src/renderer/web-index.html'),
      onwarn: ignoreIneffectiveDynamicImport
    }
  },
  worker: {
    format: 'es'
  }
})
