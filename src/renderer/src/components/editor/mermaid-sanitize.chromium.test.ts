// Why: happy-dom does not exercise DOMPurify's Chromium namespace rules for
// foreignObject XHTML; this suite is the security regression gate for #12414.
// Unit CI does not install Playwright browsers — probe once and skip honestly
// (not a silent pass) when Chromium is unavailable.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

import { mermaidSvgSanitizeConfig } from './mermaid-sanitize'

declare global {
  var DOMPurify: { sanitize: (dirty: string, config: unknown) => string } | undefined
}

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
    await page.route('https://orca-mermaid.invalid/**', (route) => route.abort())
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
        for (const element of root.querySelectorAll('*')) {
          for (const type of ['click', 'error', 'load', 'focus']) {
            element.dispatchEvent(new Event(type))
          }
        }
        if (document.body.dataset.mermaidXss) {
          throw new Error('A sanitized label executed an event handler')
        }
        return root.innerHTML
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

  it('removes nested embedded documents from HTML labels', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b>Safe</b><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><object data="javascript:alert(1)"><embed src="javascript:alert(1)" /></object></div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('<b>Safe</b>')
    expect(out).not.toMatch(/<(?:iframe|object|embed)\b|srcdoc|javascript:/i)
  }, 30_000)

  it('removes interactive form controls while preserving formatting and images', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://orca-mermaid.invalid/svg-image.png" width="20" height="20" /><foreignObject width="300" height="120"><div xmlns="http://www.w3.org/1999/xhtml"><form action="https://orca-mermaid.invalid/submit"><input name="probe" value="marker" /><button type="submit">Submit label</button><select><optgroup label="Choices"><option>Choice</option></optgroup></select><textarea>Entry</textarea><datalist><option>Suggested</option></datalist><fieldset><legend>Group</legend><label>Label</label></fieldset><output>Result</output></form><b>Safe</b><img src="https://orca-mermaid.invalid/image.png" alt="Image label" /><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).not.toMatch(
      /<(?:form|input|button|select|option|optgroup|textarea|datalist|fieldset|legend|label|output)\b/i
    )
    expect(out).toContain('<b>Safe</b>')
    expect(out).toContain('<image')
    expect(out).toContain('<img')
    expect(out).toContain('Image label')
    expect(out).toContain('<math')
  }, 30_000)

  it('removes encoded script URLs and event attributes', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b oNcLiCk="&#x64;ocument.body.dataset.mermaidXss='click'">Safe</b><a href="&#x6a;ava&#x73;cript:alert(1)">first</a><a href="java&#x09;script:alert(1)">second</a><a href="javascript&colon;alert(1)">third</a><img src="invalid:" oNeRrOr="&#100;ocument.body.dataset.mermaidXss='error'" /></div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('<b>Safe</b>')
    expect(out).toContain('first')
    expect(out).not.toMatch(/\bonclick\s*=|\bonerror\s*=|\bhref\s*=/i)
  }, 30_000)

  it('keeps encoded markup as label text through browser reparsing', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml">&lt;img src=x onerror="document.body.dataset.mermaidXss='encoded'"&gt;</div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('<img')
  }, 30_000)

  it('blocks handlers across nested MathML and HTML namespace transitions', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b>Safe</b><math xmlns="http://www.w3.org/1998/Math/MathML"><mtext><svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="invalid:" onerror="document.body.dataset.mermaidXss='namespace'" /><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe></div></foreignObject></svg></mtext><annotation-xml encoding="text/html"><div xmlns="http://www.w3.org/1999/xhtml" onclick="document.body.dataset.mermaidXss='annotation'">nested</div></annotation-xml></math></div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('<b>Safe</b>')
    expect(out).not.toMatch(/\bonerror\s*=|\bonclick\s*=|<iframe\b|srcdoc/i)
  }, 30_000)

  it('keeps generated styles and math labels without enabling SVG filter primitives', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>.label { font-weight: 700; }</style><defs><marker id="arrow"><path d="M0 0L5 5" /></marker><filter id="blur"><feGaussianBlur stdDeviation="3" /><feImage href="javascript:alert(1)" /></filter></defs><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b>Safe</b><math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup></math></div></foreignObject></svg>`
    const out = await sanitizeInChromium(svg)
    expect(out).toContain('font-weight: 700')
    expect(out).toContain('<marker')
    expect(out).toContain('<b>Safe</b>')
    expect(out).toContain('<math')
    expect(out).toContain('<msup>')
    expect(out).not.toMatch(/<feGaussianBlur\b|<feImage\b/i)
  }, 30_000)
})
