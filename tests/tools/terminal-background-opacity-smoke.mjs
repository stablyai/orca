import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { Terminal } from '@xterm/xterm';
      import { WebglAddon } from '@xterm/addon-webgl';
      import css from '@xterm/xterm/css/xterm.css';
      document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
      window.Terminal = Terminal;
      window.WebglAddon = WebglAddon;
    `,
    resolveDir: process.cwd()
  },
  bundle: true,
  write: false,
  loader: { '.css': 'text' }
})

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent('<body></body>')
  await page.addScriptTag({ content: outputFiles[0].text })
  const results = await page.evaluate(async () => {
    const results = []
    for (const renderer of ['dom', 'webgl']) {
      for (const alpha of [0, 0.4, 1]) {
        for (const [name, sgr] of [
          ['default', '0'],
          ['default-dim', '2'],
          ['rgb', '48;2;8;8;8'],
          ['rgb-dim', '2;48;2;8;8;8'],
          ['indexed', '40'],
          ['indexed256', '48;5;0'],
          ['different', '48;2;180;0;0'],
          ['selection', '48;2;8;8;8'],
          ['decoration', '48;2;8;8;8'],
          ['inverse', '38;2;8;8;8;7']
        ]) {
          const host = document.createElement('div')
          document.body.appendChild(host)
          const terminal = new window.Terminal({
            allowProposedApi: true,
            allowTransparency: true,
            cols: 6,
            rows: 1,
            theme: {
              background: `rgba(8, 8, 8, ${alpha})`,
              foreground: '#eeeeee',
              black: '#080808'
            }
          })
          terminal.open(host)
          const addon =
            renderer === 'webgl' ? new window.WebglAddon({ preserveDrawingBuffer: true }) : null
          if (addon) {
            terminal.loadAddon(addon)
          }
          await new Promise((resolve) => terminal.write(`\x1b[${sgr}mX X\x1b[0m`, resolve))
          if (name === 'selection') {
            terminal.select(0, 0, 3)
          }
          if (name === 'decoration') {
            terminal.registerDecoration({
              marker: terminal.registerMarker(0),
              width: 3,
              backgroundColor: '#080808',
              layer: 'top'
            })
          }
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
          let paintedAlpha
          if (addon) {
            const canvas = addon._renderer._canvas
            const { cell } = addon._renderer.dimensions.device
            const pixel = new Uint8Array(4)
            canvas
              .getContext('webgl2')
              .readPixels(
                Math.floor(cell.width * 1.5),
                canvas.height - Math.floor(cell.height / 2) - 1,
                1,
                1,
                0x1908,
                0x1401,
                pixel
              )
            paintedAlpha = pixel[3] / 255
          } else {
            const span = host.querySelector('.xterm-rows > div > span')
            const color = getComputedStyle(span).backgroundColor
            paintedAlpha = color.startsWith('rgba') ? Number(color.match(/[\d.]+(?=\)$)/)[0]) : 1
          }
          const storedBg = terminal.buffer.active.getLine(0).getCell(1).getBgColor()
          results.push({ renderer, alpha, name, paintedAlpha, storedBg })
          terminal.dispose()
          host.remove()
        }
      }
    }
    return results
  })
  for (const result of results) {
    const matching = ['rgb', 'rgb-dim', 'indexed', 'indexed256'].includes(result.name)
    // DOM's default background is inherited from its viewport rather than painted on each span.
    const expected = result.name.startsWith('default')
      ? result.renderer === 'dom'
        ? 0
        : result.alpha
      : matching && result.alpha < 1
        ? result.renderer === 'dom'
          ? 0
          : result.alpha
        : 1
    assert.ok(Math.abs(result.paintedAlpha - expected) < 0.01, JSON.stringify(result))
    if (result.name === 'rgb') {
      assert.equal(result.storedBg, 0x080808)
    }
  }
  console.log(`Passed ${results.length} DOM/WebGL background cases; cell data retained.`)
} finally {
  await browser.close()
}
