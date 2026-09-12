// @vitest-environment happy-dom
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let terminal: Terminal
let view: HTMLElement
let assignedSpacing: WeakMap<CSSStyleDeclaration, string>
let measurements: string[]
let fontScale: number

function update(text: string): HTMLElement {
  terminal.textarea!.value = text
  const event = new CompositionEvent('compositionupdate', { bubbles: true })
  Object.defineProperty(event, 'data', { value: text })
  terminal.textarea!.dispatchEvent(event)
  return view.querySelector<HTMLElement>('.xterm-composition-preedit')!
}

function compose(text: string): HTMLElement {
  terminal.textarea!.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true, data: '' })
  )
  return update(text)
}

function runs(preedit: HTMLElement): { text: string | null; spacing: string | undefined }[] {
  return Array.from(preedit.children, (child) => ({
    text: child.textContent,
    spacing: assignedSpacing.get((child as HTMLElement).style)
  }))
}

function rendering() {
  return (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { width: number } } } }
        _compositionHelper: { updateCompositionElements: (dontRecurse: boolean) => void }
      }
    }
  )._core
}

describe('IME preedit advances on the terminal cell grid (#19315)', () => {
  beforeEach(() => {
    measurements = []
    fontScale = 1
    assignedSpacing = new WeakMap()
    const setter = Object.getOwnPropertyDescriptor(
      CSSStyleDeclaration.prototype,
      'letterSpacing'
    )!.set!
    // happy-dom drops calc(var(...)); Electron coverage checks the resulting layout.
    vi.spyOn(CSSStyleDeclaration.prototype, 'letterSpacing', 'set').mockImplementation(
      function (this: CSSStyleDeclaration, value) {
        assignedSpacing.set(this, value)
        setter.call(this, value)
      }
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          font: '13px monospace',
          measureText(this: { font: string }, text: string) {
            measurements.push(text)
            const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 13)
            const naturalWidth = /^[\uac00-\ud7a3]$/u.test(text)
              ? 11.25
              : /^[\x20-\x7e\uff61-\uff9f]$/u.test(text)
                ? 6.5
                : 13
            return { width: naturalWidth * (fontSize / 13) * fontScale }
          }
        }) as unknown as CanvasRenderingContext2D
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal = new Terminal({ cols: 80, rows: 24, fontSize: 13, allowProposedApi: true })
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    terminal.open(container)
    view = container.querySelector<HTMLElement>('.composition-view')!
  })

  afterEach(() => {
    terminal.dispose()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('measures each font fallback separately and coalesces equal corrections', () => {
    const text = 'Aあ漢한글ｱZ'
    const preedit = compose(text)

    expect(preedit.textContent).toBe(`‎${text}‎`)
    expect(runs(preedit)).toEqual([
      { text: 'あ漢', spacing: 'calc(var(--xterm-composition-cell-width) * 2 - 13px)' },
      { text: '한글', spacing: 'calc(var(--xterm-composition-cell-width) * 2 - 11.25px)' },
      { text: 'ｱ', spacing: 'calc(var(--xterm-composition-cell-width) * 1 - 6.5px)' }
    ])
    for (const child of Array.from(preedit.children)) {
      const style = (child as HTMLElement).style
      expect(style.position).toBe('')
      expect(style.display).toBe('')
      expect(style.width).toBe('')
      expect(style.direction).toBe('')
      expect(style.unicodeBidi).toBe('')
      expect(style.fontKerning).toBe('none')
      expect(style.textDecoration).toBe('inherit')
    }
  })

  it.each([
    'سلام',
    'क्षि',
    '👩‍💻',
    '🇯🇵',
    'a\u00adb',
    'abc  XYZ',
    'ᄀ가',
    '가〮',
    'か\u3099',
    'ｶﾞ',
    '葛\u{e0100}',
    '㊗️',
    '🉐',
    'l·l'
  ])('keeps %s in one native shaping run between corrected CJK', (native) => {
    const preedit = compose(`漢${native}漢`)

    expect(preedit.textContent).toBe(`‎漢${native}漢‎`)
    expect(runs(preedit).map((run) => run.text)).toEqual(['漢', '漢'])
    expect(
      Array.from(preedit.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === native
      )
    ).toBe(true)
  })

  it.each(['\u3099', '𖿰'])('preserves leading %s without attaching it to later CJK', (mark) => {
    const preedit = compose(`${mark}漢`)

    expect(runs(preedit).map((run) => run.text)).toEqual(['漢'])
    expect(Array.from(preedit.childNodes, (node) => node.textContent)).toContain(mark)
  })

  it('does not detach a combining mark, selector, or joiner from its CJK base', () => {
    const text = '漢か\u3099葛\u{e0100}あ\u200d👩‍💻漢'
    const preedit = compose(text)

    expect(runs(preedit).map((run) => run.text)).toEqual(['漢', '漢'])
    expect(Array.from(preedit.childNodes, (node) => node.textContent)).toContain(
      'か\u3099葛\u{e0100}あ\u200d👩‍💻'
    )
    expect(preedit.textContent).toBe(`‎${text}‎`)
  })

  it.each(['a', '😀', 'سلام', 'क्षि', '\r\n', '  a'])(
    'keeps an unchanged CJK prefix corrected when %s is appended and removed',
    (suffix) => {
      const prefix = 'あ'.repeat(32)
      const initial = compose(prefix)
      const expected = runs(initial)
      const whiteSpace = initial.style.whiteSpace

      expect(runs(update(prefix + suffix))).toEqual(expected)
      expect(runs(update(prefix))).toEqual(expected)
      expect(view.querySelector<HTMLElement>('.xterm-composition-preedit')!.style.whiteSpace).toBe(
        whiteSpace
      )
    }
  )

  it('corrects long repeated text with one styled run and one cold measurement', () => {
    measurements = []
    const text = 'あ'.repeat(8192)
    const preedit = compose(text)

    expect(runs(preedit)).toEqual([
      { text, spacing: 'calc(var(--xterm-composition-cell-width) * 2 - 13px)' }
    ])
    expect(measurements.filter((value) => value === 'あ')).toHaveLength(1)
  })

  it('bounds cold measurements while preserving the exact native suffix and prefix correction', () => {
    const text = Array.from({ length: 256 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index)
    ).join('')
    measurements = []
    const preedit = compose(text)
    const corrected = runs(preedit)
    const correctedText = corrected.map((run) => run.text).join('')
    const nativeSuffix = text.slice(correctedText.length)

    expect(correctedText.length).toBeGreaterThan(0)
    expect(nativeSuffix.length).toBeGreaterThan(0)
    expect(
      measurements.filter((value) => /^[\u4e00-\u4eff]$/u.test(value)).length
    ).toBeLessThanOrEqual(128)
    expect(Array.from(preedit.childNodes, (node) => node.textContent)).toContain(nativeSuffix)
    expect(preedit.textContent).toBe(`‎${text}‎`)
    expect(runs(update(`${text}a😀`))).toEqual(corrected)
    expect(runs(update(text))).toEqual(corrected)
  })

  it('bounds alternating styled runs without splitting a native grapheme at the cutoff', () => {
    const prefix = 'あa'.repeat(256)
    const text = `${prefix}か\u3099👩‍💻`
    const preedit = compose(text)
    const corrected = runs(preedit)

    expect(corrected.length).toBeGreaterThan(0)
    expect(corrected.length).toBeLessThanOrEqual(128)
    expect(preedit.textContent).toBe(`‎${text}‎`)
    expect(Array.from(preedit.childNodes).at(-2)?.textContent).toContain('か\u3099👩‍💻')
    expect(runs(update(`${text}漢`))).toEqual(corrected)
  })

  it.each([127, 128, 129])('keeps the prefix stable at %i cold measurements', (length) => {
    const text = Array.from({ length }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('')
    const corrected = runs(compose(text))

    expect(runs(update(`${text}a👩‍💻`))).toEqual(corrected)
    expect(runs(update(text))).toEqual(corrected)
  })

  it('updates cell advances on resize without rebuilding or remeasuring glyphs', () => {
    const core = rendering()
    core._renderService.dimensions.css.cell.width = 6
    const preedit = compose('あ漢한글')
    const children = Array.from(preedit.childNodes)
    const measured = measurements.length

    core._renderService.dimensions.css.cell.width = 6.5
    core._compositionHelper.updateCompositionElements(true)

    expect(view.style.getPropertyValue('--xterm-composition-cell-width')).toBe('6.5px')
    expect(Array.from(preedit.childNodes)).toEqual(children)
    expect(measurements).toHaveLength(measured)
  })

  it('remeasures an open composition when its font changes', () => {
    const preedit = compose('あ漢')
    const initial = runs(preedit)
    terminal.options.fontSize = 16
    rendering()._compositionHelper.updateCompositionElements(true)

    expect(view.querySelector('.xterm-composition-preedit')).toBe(preedit)
    expect(runs(preedit)).toEqual([
      { text: 'あ漢', spacing: 'calc(var(--xterm-composition-cell-width) * 2 - 16px)' }
    ])
    expect(runs(preedit)).not.toEqual(initial)
  })

  it('refreshes loaded fonts during composition and removes its font listener on disposal', () => {
    const fonts = new EventTarget()
    const original = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    try {
      const preedit = compose('あ')
      fontScale = 14 / 13
      fonts.dispatchEvent(new Event('loadingdone'))

      expect(view.querySelector('.xterm-composition-preedit')).toBe(preedit)
      expect(runs(preedit)).toEqual([
        { text: 'あ', spacing: 'calc(var(--xterm-composition-cell-width) * 2 - 14px)' }
      ])
      update('')
      const afterCancel = measurements.length
      fonts.dispatchEvent(new Event('loadingdone'))
      expect(measurements).toHaveLength(afterCancel)
      update('あ')
      terminal.dispose()
      const measured = measurements.length
      fonts.dispatchEvent(new Event('loadingdone'))
      expect(measurements).toHaveLength(measured)
    } finally {
      if (original) {
        Object.defineProperty(document, 'fonts', original)
      } else {
        Reflect.deleteProperty(document, 'fonts')
      }
    }
  })

  it.each([
    { name: 'mixed', text: '漢か\u3099a👩‍💻' },
    { name: 'budgeted', text: 'あa'.repeat(256) }
  ])('keeps $name provisional text out of the PTY and commits exactly once', async ({ text }) => {
    const sent: string[] = []
    terminal.onData((data) => sent.push(data))
    compose(text)
    expect(sent).toEqual([])

    terminal.textarea!.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: text })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(sent).toEqual([text])
    expect(view.children).toHaveLength(0)
  })

  it('clears styled and native nodes on cancellation and disposal', () => {
    compose('漢か\u3099a👩‍💻')
    update('')
    expect(view.children).toHaveLength(0)
    update('漢か\u3099a👩‍💻')
    terminal.dispose()
    expect(view.children).toHaveLength(0)
  })
})
