import { describe, expect, it } from 'vitest'
import { fetchesCustomCssResource } from './custom-css'

describe('fetchesCustomCssResource', () => {
  it('allows plain values and inline data: URLs', () => {
    expect(fetchesCustomCssResource('#1e1e2e')).toBe(false)
    expect(fetchesCustomCssResource('color-mix(in srgb, var(--foreground) 7%, #000)')).toBe(false)
    expect(fetchesCustomCssResource('url("data:image/png;base64,AAAA")')).toBe(false)
    expect(fetchesCustomCssResource('image-set(url("data:image/png;base64,AAAA") 1x)')).toBe(false)
    expect(
      fetchesCustomCssResource(
        `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>")`
      )
    ).toBe(false)
  })

  it('flags absolute and protocol-relative network URLs', () => {
    expect(fetchesCustomCssResource('url("https://example.com/a.png")')).toBe(true)
    expect(fetchesCustomCssResource('url(http://example.com/a.png) no-repeat')).toBe(true)
    expect(fetchesCustomCssResource('url(HTTPS://example.com/a.png)')).toBe(true)
    expect(fetchesCustomCssResource('url(//example.com/a.png)')).toBe(true)
    expect(fetchesCustomCssResource('image-set("//example.com/a.png" 1x)')).toBe(true)
    expect(
      fetchesCustomCssResource('url("data:image/png;base64,AA"), url(https://example.com/b.png)')
    ).toBe(true)
  })

  it('flags the spellings the URL parser normalizes back into a fetch', () => {
    // An escaped tab splits the scheme in the CSS text; Chromium strips it before resolving.
    expect(fetchesCustomCssResource('url("htt\\9 ps://example.com/beacon")')).toBe(true)
    expect(fetchesCustomCssResource('url(h\\74tps://example.com/a.png)')).toBe(true)
    expect(fetchesCustomCssResource('url(\\68 ttp://example.com)')).toBe(true)
    // The parser folds `\` to `/`, so a UNC path is a file://server/share fetch.
    expect(fetchesCustomCssResource('url(\\\\server\\share\\x.png)')).toBe(true)
    expect(fetchesCustomCssResource('@import "htt\\9 ps://example.com/a.css";')).toBe(true)
    expect(fetchesCustomCssResource('@import "htt\\\nps://example.com/a.css";')).toBe(true)
  })

  it('flags every reference that is not a data: URL', () => {
    expect(fetchesCustomCssResource('url(file://server/share/x.png)')).toBe(true)
    expect(fetchesCustomCssResource('url(/abs.png)')).toBe(true)
    expect(fetchesCustomCssResource('url(rel.png)')).toBe(true)
    expect(fetchesCustomCssResource('url(wallpaper.png)')).toBe(true)
    expect(fetchesCustomCssResource('image-set("x.png" 1x)')).toBe(true)
    expect(fetchesCustomCssResource('src("fonts/x.woff2")')).toBe(true)
    // Chromium keeps U+00A0 inside the URL, so neither of these is a data: URL.
    expect(fetchesCustomCssResource('url("\u00a0data:image/png;base64,AAAA")')).toBe(true)
    expect(fetchesCustomCssResource('url("d\\61\u00a0ta:image/png;base64,AAAA")')).toBe(true)
  })
})
