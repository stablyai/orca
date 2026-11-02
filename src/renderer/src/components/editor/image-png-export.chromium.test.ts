// Why: happy-dom has no canvas taint rules; Chromium taints blob-URL SVGs with HTML labels.
// Unit CI does not install Playwright browsers — probe once and skip when Chromium is unavailable.
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from '@playwright/test'
import * as esbuild from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import type { renderImagePngDataUrl as RenderPng } from './image-png-export'

declare global {
  var pngExport: { renderImagePngDataUrl: typeof RenderPng } | undefined
}

const browser: Browser | null = await chromium.launch({ headless: true }).catch(() => null)

afterAll(async () => {
  await browser?.close()
})

const LABELED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">' +
  '<foreignObject width="120" height="40"><div xmlns="http://www.w3.org/1999/xhtml">' +
  '<b>label</b></div></foreignObject></svg>'

describe.skipIf(!browser)('renderImagePngDataUrl in Chromium', () => {
  it('copies a blob-URL SVG with HTML labels as a PNG', async () => {
    const bundle = await esbuild.build({
      entryPoints: [fileURLToPath(new URL('./image-png-export.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      globalName: 'pngExport',
      write: false
    })
    if (!browser) {
      throw new Error('Chromium is unavailable')
    }
    const page = await browser.newPage()
    try {
      await page.setContent('<!doctype html><html><body></body></html>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const result = await page.evaluate(async (svg) => {
        if (!globalThis.pngExport) {
          throw new Error('Export bundle not loaded')
        }
        const { renderImagePngDataUrl } = globalThis.pngExport
        const src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        return renderImagePngDataUrl(src, { width: 120, height: 40 }, '#ffffff').then(
          (png) => png.slice(0, 22),
          (error: Error) => error.message
        )
      }, LABELED_SVG)
      expect(result).toBe('data:image/png;base64,')
    } finally {
      await page.close()
    }
  })
})
