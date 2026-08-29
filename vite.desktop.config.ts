import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve('out/desktop-ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/renderer/desktop-index.html')
    }
  },
  worker: {
    format: 'es'
  }
})
