// Why: happy-dom does not exercise DOMPurify's Chromium namespace rules for
// foreignObject XHTML; this suite is the security regression gate for #12414.
// Unit CI does not install Playwright browsers — probe once and skip honestly
// (not a silent pass) when Chromium is unavailable.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

import { mermaidSvgSanitizeConfig } from './mermaid-sanitize'

const require = createRequire(import.meta.url)

async function probeChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true })
    await browser.close()
    return true
  } catch {
    return false
  }
}

const chromiumAvailable = await probeChromium()

async function sanitizeInChromium(svg: string): Promise<string> {
  const purifyPath = require.resolve('dompurify/dist/purify.min.js')
  const purifySrc = readFileSync(purifyPath, 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><body></body></html>')
    await page.addScriptTag({ content: purifySrc })
    return await page.evaluate(
      ({ svg, cfg }) => {
        const purify = (
          globalThis as unknown as {
            DOMPurify: { sanitize: (dirty: string, config: unknown) => string }
          }
        ).DOMPurify
        return purify.sanitize(svg, cfg)
      },
      { svg, cfg: mermaidSvgSanitizeConfig }
    )
  } finally {
    await browser.close()
  }
}

describe.skipIf(!chromiumAvailable)('sanitizeMermaidSvg (Chromium)', () => {
  it('keeps mermaid HTML label formatting tags inside foreignObject', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b>Bold</b> and <i>italic</i></div></foreignObject></g></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('foreignObject')
    expect(out).toMatch(/<b[\s>]/i)
    expect(out).toMatch(/<i[\s>]/i)
    expect(out).toContain('Bold')
  }, 30_000)

  it('strips script, event handlers, and javascript: URLs while keeping label text', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b onclick="alert(1)">Bold</b><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)"></div></foreignObject><script>alert(2)</script></g></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('Bold')
    expect(out).toMatch(/<b[\s>]/i)
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out.toLowerCase()).not.toContain('onerror')
    expect(out.toLowerCase()).not.toContain('javascript:')
  }, 30_000)
})
