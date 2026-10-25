import { createServer } from 'node:http'

export type BrowserSplitPageServer = {
  /**
   * `/<pane>/<step>` serves an uncached page titled "<pane> <step>". Chromium shares page zoom
   * per host, so give sibling panes different hosts (127.0.0.1 vs localhost) to keep zoom apart.
   */
  pageUrl: (pane: string, step: number, host?: '127.0.0.1' | 'localhost') => string
  close: () => Promise<void>
}

export async function startBrowserSplitPageServer(): Promise<BrowserSplitPageServer> {
  const server = createServer((request, response) => {
    const [, pane = 'page', step = '1'] = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      .split('/')
      .map((segment) => segment.replace(/[^\w-]/g, ''))
    // Why: no-store makes soft and hard reload both reach the network, like a dev server page.
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(
      `<!doctype html><html><head><title>${pane} ${step}</title></head><body><h1>Pane ${pane}, page ${step}</h1><p>Split shortcut fixture.</p></body></html>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Browser split page server has no TCP port')
  }
  const { port } = address
  return {
    pageUrl: (pane, step, host = '127.0.0.1') => `http://${host}:${port}/${pane}/${step}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}
