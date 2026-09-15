import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [react(), tailwindcss()],
  define: { ORCA_FEATURE_WALL_ENABLED: 'true' },
  resolve: {
    alias: { '@': resolve('src/renderer/src'), '@renderer': resolve('src/renderer/src') }
  },
  server: { host: '127.0.0.1', port: 5183, strictPort: true }
})
await server.listen()
