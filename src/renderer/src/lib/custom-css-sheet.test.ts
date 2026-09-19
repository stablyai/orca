// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { applyCustomCssSheet, buildCustomCssSheet, stripResourceFetches } from './custom-css-sheet'

function cssText(sheet: CSSStyleSheet): string {
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')
}

describe('buildCustomCssSheet', () => {
  it('drops declarations that load from the network and keeps the rest', () => {
    const sheet = buildCustomCssSheet(
      [
        '.a { background-image: url("https://example.com/a.png"); color: blue; }',
        ':root { --wallpaper: url(//example.com/b.png); --sidebar: #181825; }'
      ].join('\n')
    )
    const text = cssText(sheet)
    expect(text).not.toContain('example.com')
    expect(text).toContain('blue')
    expect(text).toContain('#181825')
  })

  it('drops relative and file:// references and keeps inline data: URLs', () => {
    const sheet = buildCustomCssSheet(
      [
        '.a { background-image: url("wallpaper.png"); }',
        '.b { background-image: url(file://server/share/x.png); }',
        '.c { background-image: url("data:image/png;base64,AAAA"); }'
      ].join('\n')
    )
    const text = cssText(sheet)
    expect(text).not.toContain('wallpaper.png')
    expect(text).not.toContain('server')
    expect(text).toContain('data:image/png')
  })
})

type StubRule = { cssText: string; cssRules?: StubRule[]; deleteRule?: (index: number) => void }

function stubContainer(rules: StubRule[]): {
  cssRules: StubRule[]
  deleteRule: (index: number) => void
} {
  return { cssRules: rules, deleteRule: (index) => void rules.splice(index, 1) }
}

describe('stripResourceFetches', () => {
  const remoteProperty = {
    cssText:
      '@property --img { syntax: "<image>"; inherits: false; initial-value: url(https://example.com/a.png); }'
  }
  const localCounter = { cssText: '@counter-style dots { system: cyclic; symbols: "•"; }' }

  it('drops rules CSSOM cannot inspect when they load remotely, at any depth', () => {
    // A group's cssText embeds its children, so it must be recursed into, not dropped by mention.
    const media = {
      cssText: `@media screen { ${remoteProperty.cssText} }`,
      ...stubContainer([{ ...remoteProperty }, localCounter])
    }
    const sheet = stubContainer([{ ...remoteProperty }, localCounter, media])

    stripResourceFetches(sheet)

    expect(sheet.cssRules).toEqual([localCounter, media])
    expect(media.cssRules).toEqual([localCounter])
  })

  it('keeps style rules that only mention a URL outside any value', () => {
    const sheet = buildCustomCssSheet('a[href^="https://"] { color: red; }')
    expect(cssText(sheet)).toContain('color: red')
  })
})

describe('applyCustomCssSheet', () => {
  afterEach(() => {
    applyCustomCssSheet(document, null)
  })

  it('replaces its own sheet and leaves other adopted sheets alone', () => {
    const other = new CSSStyleSheet()
    document.adoptedStyleSheets = [other]
    const first = buildCustomCssSheet(':root { --background: #111; }')
    const second = buildCustomCssSheet(':root { --background: #222; }')

    applyCustomCssSheet(document, first)
    applyCustomCssSheet(document, second)
    expect(document.adoptedStyleSheets).toEqual([other, second])

    applyCustomCssSheet(document, null)
    expect(document.adoptedStyleSheets).toEqual([other])
  })
})
