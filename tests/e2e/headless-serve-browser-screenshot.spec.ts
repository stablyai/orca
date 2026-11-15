// A serve page on a headless display has no window on screen; its screenshot must still show the page (#26138).
import { createServer } from 'node:http'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import {
  addRepoWorktree,
  cliClient,
  startHeadlessOracleHost
} from './helpers/headless-layout-oracle-hosts'

// Blue at the top-left corner: the broken capture was the whole frame in that one colour.
const FIXTURE = `<!doctype html><title>capture</title><body style="margin:0;background:#fff">
<div style="position:absolute;left:0;top:0;width:8px;height:8px;background:#00f"></div>
<div style="position:absolute;left:200px;top:100px;width:600px;height:400px;background:#00c000"></div>`

function countGreenAndWhite(png: PNG): { green: number; white: number } {
  let green = 0
  let white = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = png.data.subarray(i, i + 3)
    if (r < 40 && g > 160 && b < 40) {
      green++
    } else if (r > 230 && g > 230 && b > 230) {
      white++
    }
  }
  return { green, white }
}

test('a serve browser page screenshot shows the page, not one colour', async () => {
  test.setTimeout(300_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(FIXTURE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('page server has no port')
  }
  const host = await startHeadlessOracleHost('electron')
  try {
    const cli = cliClient(host)
    const worktree = `id:${await addRepoWorktree(host, cli)}`
    const created = await cli.call<{ browserPageId: string }>('browser.tabCreate', {
      worktree,
      url: `http://127.0.0.1:${address.port}/`
    })
    const page = created.result.browserPageId
    await expect
      .poll(
        async () =>
          (
            await cli.call<{ result: string }>('browser.eval', {
              worktree,
              page,
              expression: 'document.readyState'
            })
          ).result.result,
        { timeout: 30_000 }
      )
      .toBe('complete')

    // Reporters saw a 1x1 first frame, then frames holding only the background colour.
    for (let attempt = 0; attempt < 3; attempt++) {
      const shot = await cli.call<{ data: string }>('browser.screenshot', {
        worktree,
        page,
        format: 'png'
      })
      const png = PNG.sync.read(Buffer.from(shot.result.data, 'base64'))
      expect(png.width).toBeGreaterThanOrEqual(1000)
      const { green, white } = countGreenAndWhite(png)
      // The 600x400 box and the page around it, in CSS pixels.
      expect(green).toBeGreaterThan(200_000)
      expect(white).toBeGreaterThan(200_000)
    }
  } finally {
    await host.dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})
