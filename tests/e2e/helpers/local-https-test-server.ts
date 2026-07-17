import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from './local-https-test-certificate'

export type LocalHttpsServer = {
  secureUrl: string
  schemeLessUrl: string
  documentRequestCount: () => number
  assetRequestCount: () => number
  webSocketConnectionCount: () => number
  close: () => Promise<void>
}

export type LocalHttpProbeServer = {
  url: string
  close: () => Promise<void>
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  )
}

export async function startLocalHttpsServer(): Promise<LocalHttpsServer> {
  let documentRequestCount = 0
  let assetRequestCount = 0
  let webSocketConnectionCount = 0
  let secureOrigin = ''
  const server = createHttpsServer(
    { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
    (request, response) => {
      const requestUrl = new URL(request.url ?? '/', secureOrigin)
      if (requestUrl.pathname === '/asset.svg') {
        assetRequestCount += 1
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'image/svg+xml; charset=utf-8'
        })
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
        return
      }
      // Why: count only the root document. Favicon/probes would inflate the
      // document counter and flake exact E2E request-count assertions.
      if (requestUrl.pathname !== '/') {
        response.writeHead(404)
        response.end()
        return
      }
      documentRequestCount += 1
      const socketUrl = `${secureOrigin.replace('https:', 'wss:')}/socket`
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      })
      response.end(`
        <!doctype html>
        <html>
          <head><title>Untrusted TLS page</title></head>
          <body>
            <h1>Local HTTPS request ${documentRequestCount}</h1>
            <img src="/asset.svg" alt="TLS asset">
            <script>
              window.__localTlsState = { asset: false, webSocket: false }
              document.querySelector('img').addEventListener('load', () => {
                window.__localTlsState.asset = true
              })
              const socket = new WebSocket(${JSON.stringify(socketUrl)})
              socket.addEventListener('message', () => {
                window.__localTlsState.webSocket = true
                socket.close()
              })
            </script>
          </body>
        </html>
      `)
    }
  )
  const webSocketServer = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/socket') {
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request)
    })
  })
  webSocketServer.on('connection', (client) => {
    webSocketConnectionCount += 1
    client.send('ready')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  secureOrigin = `https://127.0.0.1:${port}`

  return {
    secureUrl: `${secureOrigin}/`,
    schemeLessUrl: `127.0.0.1:${port}/`,
    documentRequestCount: () => documentRequestCount,
    assetRequestCount: () => assetRequestCount,
    webSocketConnectionCount: () => webSocketConnectionCount,
    close: async () => {
      for (const client of webSocketServer.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
      await closeServer(server)
    }
  }
}

export async function startLocalHttpProbeServer(
  target: LocalHttpsServer
): Promise<LocalHttpProbeServer> {
  const assetUrl = new URL('/asset.svg', target.secureUrl).toString()
  const socketUrl = new URL('/socket', target.secureUrl).toString().replace('https:', 'wss:')
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`
      <!doctype html>
      <html>
        <head><title>Sibling TLS probe</title></head>
        <body>
          <h1>Sibling TLS probe</h1>
          <img alt="Sibling TLS asset">
          <script>
            window.__siblingTlsProbe = { asset: 'pending', webSocket: 'pending' }
            const image = document.querySelector('img')
            image.addEventListener('load', () => { window.__siblingTlsProbe.asset = 'allowed' })
            image.addEventListener('error', () => { window.__siblingTlsProbe.asset = 'blocked' })
            image.src = ${JSON.stringify(assetUrl)}
            const socket = new WebSocket(${JSON.stringify(socketUrl)})
            socket.addEventListener('open', () => {
              window.__siblingTlsProbe.webSocket = 'allowed'
              socket.close()
            })
            socket.addEventListener('error', () => {
              window.__siblingTlsProbe.webSocket = 'blocked'
            })
          </script>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/`, close: () => closeServer(server) }
}
