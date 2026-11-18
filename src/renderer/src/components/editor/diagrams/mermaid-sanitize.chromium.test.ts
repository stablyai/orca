// Chromium exercises DOMPurify's foreignObject HTML/MathML integration.
// Unit CI does not install Playwright browsers — probe once and skip honestly
// (not a silent pass) when Chromium is unavailable.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'

import { mermaidSvgSanitizeConfig } from './mermaid-sanitize'

declare global {
  var DOMPurify: { sanitize: (dirty: string, config: unknown) => string } | undefined
}

const require = createRequire(import.meta.url)

const browser: Browser | null = await chromium.launch({ headless: true }).catch(() => null)
const chromiumAvailable = browser !== null

afterAll(async () => {
  await browser?.close()
})

async function sanitizeInChromium(svg: string): Promise<string> {
  const purifyPath = require.resolve('dompurify/dist/purify.min.js')
  const purifySrc = readFileSync(purifyPath, 'utf8')
  if (!browser) {
    throw new Error('Chromium is unavailable')
  }
  const page = await browser.newPage()
  try {
    await page.setContent('<!doctype html><html><body></body></html>')
    await page.addScriptTag({ content: purifySrc })
    return await page.evaluate(
      ({ svg, cfg }) => {
        if (!globalThis.DOMPurify) {
          throw new Error('DOMPurify not loaded')
        }
        const clean = globalThis.DOMPurify.sanitize(svg, cfg)
        const root = document.createElement('div')
        document.body.append(root)
        root.innerHTML = clean
        return root.innerHTML
      },
      { svg, cfg: mermaidSvgSanitizeConfig }
    )
  } finally {
    await page.close()
  }
}

describe.skipIf(!chromiumAvailable)('sanitizeMermaidSvg (Chromium)', () => {
  it('removes form controls while preserving HTML and MathML labels', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="300" height="120"><div xmlns="http://www.w3.org/1999/xhtml"><form><input name="probe" /><button>Submit</button></form><b>Safe</b><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).not.toMatch(/<(?:form|input|button)\b/i)
    expect(out).toContain('<b>Safe</b>')
    expect(out).toContain('<math')
  })
})
