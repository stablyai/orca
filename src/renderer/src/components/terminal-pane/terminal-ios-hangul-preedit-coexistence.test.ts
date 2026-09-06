// @vitest-environment happy-dom
/**
 * What the iPadOS Hangul path must not disturb: the composition sessions other
 * input sources on the same device do run, non-Hangul scripts, desktop
 * platforms, and anything else that writes to the PTY.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import {
  disposeOpenTerminals,
  dispatchComposition,
  dispatchInput,
  dispatchKey,
  nextEventLoop,
  openIosTerminal,
  pretendIosWeb,
  typeHangeul,
  typeJamo,
  typePrintable,
  type IosHangulRig
} from './terminal-ios-hangul-preedit-fixture'

/** Chinese pinyin, which fires real composition events on the very same iPad. */
async function typePinyin(rig: IosHangulRig, spelling: string, committed: string): Promise<void> {
  const base = rig.textarea.value
  dispatchComposition(rig, 'compositionstart', '')
  for (let index = 1; index <= spelling.length; index += 1) {
    const preedit = spelling.slice(0, index)
    dispatchKey(rig, 'keydown', {
      key: spelling[index - 1],
      keyCode: 229,
      isComposing: true
    })
    dispatchComposition(rig, 'compositionupdate', preedit)
    rig.textarea.value = base + preedit
    dispatchInput(rig, 'insertCompositionText', preedit, { isComposing: true })
  }
  rig.textarea.value = base + committed
  dispatchComposition(rig, 'compositionend', committed)
  dispatchInput(rig, 'insertCompositionText', committed)
  await nextEventLoop()
  await nextEventLoop()
}

describe('the iPadOS Hangul path alongside everything else', () => {
  let originalUserAgent: PropertyDescriptor | undefined
  let originalMaxTouchPoints: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    disposeOpenTerminals()
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent)
    }
    if (originalMaxTouchPoints) {
      Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints)
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  describe('Chinese pinyin on the same device', () => {
    it('commits once, not twice', async () => {
      pretendIosWeb()
      const rig = openIosTerminal()
      await typePinyin(rig, 'ni', '你')

      expect(rig.emitted).toEqual(['你'])
    })

    it('commits two compositions in a row', async () => {
      pretendIosWeb()
      const rig = openIosTerminal()
      await typePinyin(rig, 'ni', '你')
      await typePinyin(rig, 'hao', '好')

      expect(rig.emitted).toEqual(['你', '好'])
    })

    it('still works after Hangul was typed first', async () => {
      pretendIosWeb()
      const rig = openIosTerminal()
      await typeHangeul(rig)
      await typePinyin(rig, 'ni', '你')

      // The open syllable is committed by the composition that supersedes it.
      expect(rig.emitted).toEqual(['한', '글', '你'])
    })

    it('leaves Hangul working after a composition finished', async () => {
      pretendIosWeb()
      const rig = openIosTerminal()
      await typePinyin(rig, 'ni', '你')
      await typeHangeul(rig)
      dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

      expect(rig.emitted).toEqual(['你', '한', '글', '\r'])
    })
  })

  it('composes Hangul after a composition that never ended, then a blur', async () => {
    // Why this case: a `composing` flag latched on compositionstart and cleared
    // only on compositionend stays true forever when the session is abandoned —
    // blur mid-composition, pane teardown, a cancelled IME — and silently kills
    // every claimed key for the rest of the pane's life. The state is derived
    // from the composition tracker instead, which a blur clears.
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchComposition(rig, 'compositionstart', '')
    dispatchComposition(rig, 'compositionupdate', 'n')
    rig.textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    rig.textarea.value = ''
    await nextEventLoop()

    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toContain('한글')
  })

  it('commits a Japanese kana-to-kanji session once, like pinyin', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typePinyin(rig, 'ka', '蚊')

    expect(rig.emitted).toEqual(['蚊'])
  })

  it('leaves a Hanja lookup to the session that owns its preedit', async () => {
    // Why: ibus-hangul indexes its Hanja table by digit, but only over a live
    // composition — which xterm's CompositionHelper already commits.
    pretendIosWeb()
    const rig = openIosTerminal()
    await typePinyin(rig, 'han', '韓')

    expect(rig.emitted).toEqual(['韓'])
  })

  it('sends a digit after a held syllable as the literal text that ends it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    await typeJamo(rig, 'ㅏ', '하', { replaces: true })
    await typePrintable(rig, { key: '1', keyCode: 49, written: '1', replaces: false })

    expect(rig.emitted).toEqual(['하', '1'])
  })

  describe('desktop platforms', () => {
    it('is inert on a Mac reporting no touch points', async () => {
      pretendIosWeb(0)
      const rig = openIosTerminal()
      await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

      expect(rig.emitted).toEqual(['ㅎ'])
      expect(rig.compositionView.classList.contains('active')).toBe(false)
    })

    it('is inert on a Mac whose touch peripheral reports a single point', async () => {
      pretendIosWeb(1)
      const rig = openIosTerminal()
      await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

      expect(rig.emitted).toEqual(['ㅎ'])
      expect(rig.compositionView.classList.contains('active')).toBe(false)
    })

    it('is inert on Windows and Linux', async () => {
      for (const userAgent of [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0'
      ]) {
        pretendIosWeb(5, userAgent)
        const rig = openIosTerminal()
        await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
        expect(rig.emitted).toEqual(['ㅎ'])
      }
    })

    it('reads the platform once, so no second gate can drift from it', () => {
      const lifecycle = readFileSync(
        resolve(
          process.cwd(),
          'src/renderer/src/components/terminal-pane/terminal-pane-pane-input.ts'
        ),
        'utf8'
      )
      expect(lifecycle.match(/const isIosWeb =/g)).toHaveLength(1)
      expect(lifecycle.match(/isCurrentPlatformIosWeb\(/g)).toHaveLength(1)
      // And that the one gate is what installs the controller.
      expect(lifecycle).toMatch(
        /const iosHangulPreedit = isIosWeb\s*\?\s*installTerminalIosHangulPreedit\(/
      )
    })
  })

  it('composes Hangul after a paste written straight to the transport', async () => {
    // Why: `writeTerminalPastePtyInput` bypasses xterm entirely, so it fires no
    // `onData` a mirror could resync on. A hold reads the field only when it
    // opens, so there is no state for the paste to make stale.
    pretendIosWeb()
    const rig = openIosTerminal()
    const sent: string[] = []
    writeTerminalPastePtyInput({ sendInput: (data) => (sent.push(data), true) }, 'echo ')
    expect(sent).toEqual(['echo '])

    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted).toEqual(['한', '글', '\r'])
  })

  it('leaves non-Hangul scripts on the same device reaching the PTY', async () => {
    // Why: the bypass claims a key that nothing downstream re-sends, so it must
    // claim only jamo. A Cyrillic or kana key would otherwise lose its keydown,
    // its keypress and its `input` alike and arrive as nothing.
    pretendIosWeb()
    const rig = openIosTerminal()
    for (const key of ['п', 'р', 'α', 'ω', 'あ', 'カ', 'é', 'ü', '€']) {
      await typePrintable(rig, { key, keyCode: 71, written: key, replaces: false })
    }

    expect(rig.emitted).toEqual(['п', 'р', 'α', 'ω', 'あ', 'カ', 'é', 'ü', '€'])
  })
})
