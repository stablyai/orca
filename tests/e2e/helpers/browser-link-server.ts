import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  )
}

export async function startBrowserLinkServer(): Promise<{
  sourceUrl: string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const pathname = new URL(request.url ?? '/', origin).pathname
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (pathname === '/destination') {
      response.end(
        `<!doctype html><html><head><title>Linked destination</title></head><body>Destination <a id="return-link" href="${origin}/source">Return</a></body></html>`
      )
      return
    }
    if (pathname === '/blank-destination') {
      response.end(
        '<!doctype html><html><head><title>Blank target destination</title></head><body>Blank target destination</body></html>'
      )
      return
    }
    if (pathname === '/frame-destination') {
      response.end(
        `<!doctype html><html><head><title>Frame destination</title></head><body>Frame destination <a id="return-link" href="${origin}/source">Return</a></body></html>`
      )
      return
    }
    if (pathname === '/frame-modifier-destination') {
      response.end(
        '<!doctype html><html><head><title>Frame modifier destination</title></head><body>Frame modifier destination</body></html>'
      )
      return
    }
    if (pathname === '/frame-middle-destination') {
      response.end(
        '<!doctype html><html><head><title>Frame middle destination</title></head><body>Frame middle destination</body></html>'
      )
      return
    }
    if (pathname === '/frame') {
      response.end(
        `<!doctype html><html><head><title>${request.url?.includes('shift-middle') ? 'Frame shift middle destination' : ''}</title></head><body><a style="display:block" id="frame-link" href="${origin}/frame-destination" target="_blank">Open frame destination</a><a style="display:block" id="frame-modifier-link" href="${origin}/frame-modifier-destination">Open frame modifier destination</a><a style="display:block" id="frame-middle-link" href="${origin}/frame-middle-destination">Open frame middle destination</a><a style="display:block" id="frame-shift-middle-link" href="${origin}/frame?shift-middle">Open foreground frame tab</a></body></html>`
      )
      return
    }
    if (pathname === '/modifier-destination') {
      response.end(
        '<!doctype html><html><head><title>Modifier destination</title></head><body>Modifier destination</body></html>'
      )
      return
    }
    if (pathname === '/middle-destination') {
      response.end(
        '<!doctype html><html><head><title>Middle-click destination</title></head><body>Middle-click destination</body></html>'
      )
      return
    }
    response.end(`
      <!doctype html>
      <html>
        <head><title>${request.url?.includes('shift-middle') ? 'Shift middle destination' : 'Source page'}</title></head>
        <body>
          <a id="external-link" href="${origin}/destination" target="_blank">Open destination</a>
          <a id="blank-link" href="${origin}/blank-destination" target="_blank">Open blank target destination</a>
          <a id="modifier-link" href="${origin}/modifier-destination">Open with modifier</a>
          <a id="middle-link" href="${origin}/middle-destination">Open with middle click</a>
          <a id="shift-middle-link" href="${origin}/source?shift-middle">Open foreground tab</a>
          <a id="cancelled-link" href="${origin}/destination" target="_blank">Handle in page</a>
          <iframe id="link-frame" src="${origin}/frame" title="Embedded links"></iframe>
          <script>
            document.querySelector('#cancelled-link').addEventListener('click', (event) => {
              event.preventDefault()
              document.title = 'Click handled in page'
            })
          </script>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    sourceUrl: `http://127.0.0.1:${port}/source`,
    close: () => closeServer(server)
  }
}
