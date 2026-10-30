// @vitest-environment happy-dom
/** iPad hardware Hangul rewrites its textarea without composition events (#13345); xterm otherwise sends raw jamo and drops composed input. Exercise the pane’s real tracker, bypass and preedit stack. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  typePrintable
} from './terminal-ios-hangul-preedit-fixture'

describe('iPadOS Hangul typed as bare keydowns', () => {
  let originalUserAgent: PropertyDescriptor | undefined
  let originalMaxTouchPoints: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
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

  it('sends composed syllables, not the jamo the keydowns carry', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted).toEqual(['한', '글', '\r'])
  })

  it('commits a syllable once, with no intermediate state to retract', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)

    // Only the syllable the IME finished has been sent; `글` is still held.
    expect(rig.emitted).toEqual(['한'])
    expect(rig.preedit.heldText()).toBe('글')
  })

  it('shows the open syllable in the preedit overlay as it grows', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    expect(rig.compositionView.classList.contains('active')).toBe(true)
    expect(rig.compositionView.textContent).toBe('ㅎ')

    await typeJamo(rig, 'ㅏ', '하', { replaces: true })
    expect(rig.compositionView.textContent).toBe('하')
    expect(rig.emitted).toEqual([])
  })

  it('hides the overlay once the syllable is committed', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.textContent).toBe('')
    expect(rig.emitted).toEqual(['ㅎ', '\r'])
  })

  it('composes after text already sitting on the line', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    for (const [key, keyCode] of [
      ['e', 69],
      ['c', 67],
      ['h', 72],
      ['o', 79],
      [' ', 32]
    ] as const) {
      await typePrintable(rig, { key, keyCode, written: key, replaces: false })
    }
    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toBe('echo 한글\r')
  })

  it('leaves ASCII typing on the same device untouched', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typePrintable(rig, { key: 'l', keyCode: 76, written: 'l', replaces: false })
    await typePrintable(rig, { key: 's', keyCode: 83, written: 's', replaces: false })

    expect(rig.emitted).toEqual(['l', 's'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('commits the open syllable before the space that follows it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)
    await typePrintable(rig, { key: ' ', keyCode: 32, written: ' ', replaces: false })

    expect(rig.emitted).toEqual(['한', '글', ' '])
  })

  it('commits the open syllable when the textarea loses focus', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)
    rig.textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    await nextEventLoop()

    expect(rig.emitted).toEqual(['한', '글'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('lets Backspace decompose the open syllable without reaching the PTY', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    await typeJamo(rig, 'ㅏ', '하', { replaces: true })

    // The IME walks the syllable back a jamo at a time by rewriting the field.
    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.compositionView.textContent).toBe('ㅎ')
  })

  it('sends Backspace to the PTY once no syllable is open', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    rig.textarea.value = ''
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()
    expect(rig.emitted).toEqual([])

    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    await nextEventLoop()
    expect(rig.emitted).toEqual(['\x7f'])
  })

  it('keeps the syllable painted between the delete and insert that replace it', async () => {
    // Transient empty fields between delete/insert halves must not blank the overlay.
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, '\u314E', '\u314E', { replaces: false })

    dispatchKey(rig, 'keydown', { key: '\u3153', keyCode: '\u3153'.charCodeAt(0) })
    rig.textarea.value = ''
    dispatchInput(rig, 'deleteContentBackward', null)
    expect(rig.compositionView.textContent).toBe('\u314E')

    rig.textarea.value = '\uD5E4'
    dispatchInput(rig, 'insertText', '\uD5E4')
    await nextEventLoop()
    expect(rig.compositionView.textContent).toBe('\uD5E4')
  })

  it('holds the syllable when Backspace decomposes it as delete-then-insert', async () => {
    // Shrinking syllables can also use delete-then-insert; the emptied half cannot close the hold and leak raw jamo.
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, '\u314E', '\uD558', { replaces: false })
    await typeJamo(rig, '\u3153', '\uD5E4', { replaces: true })
    await typeJamo(rig, '\u3134', '\uD5E8', { replaces: true })

    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    rig.textarea.value = ''
    dispatchInput(rig, 'deleteContentBackward', null)
    rig.textarea.value = '\uD5E4'
    dispatchInput(rig, 'insertText', '\uD5E4')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('\uD5E4')

    await typeJamo(rig, '\u3139', '\uD5EC', { replaces: true })
    dispatchKey(rig, 'keydown', { key: ' ', code: 'Space', keyCode: 32 })
    await nextEventLoop()
    expect(rig.emitted.join('')).toContain('\uD5EC')
  })

  it('does not resurrect the opening jamo after Backspace emptied the field', async () => {
    // Why: the openKey is owed to the PTY only while the IME has written nothing.
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, '\u314E', '\u314E', { replaces: false })

    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    rig.textarea.value = ''
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()

    dispatchKey(rig, 'keydown', { key: ' ', code: 'Space', keyCode: 32 })
    await nextEventLoop()
    expect(rig.emitted.join('')).not.toContain('\u314E')
  })

  it('composes one syllable from a field the IME leaves decomposed', async () => {
    // NFD appends jamo, which would falsely settle each one separately without normalization.
    pretendIosWeb()
    const rig = openIosTerminal()
    const steps: [string, string][] = [
      ['\u314E', '\u1112'],
      ['\u3153', '\u1112\u1165'],
      ['\u3134', '\u1112\u1165\u11AB']
    ]
    for (const [key, field] of steps) {
      dispatchKey(rig, 'keydown', { key, keyCode: key.charCodeAt(0) })
      rig.textarea.value = field
      dispatchInput(rig, 'insertText', field.slice(-1))
      await nextEventLoop()
      expect(rig.emitted).toEqual([])
    }

    dispatchKey(rig, 'keydown', { key: ' ', code: 'Space', keyCode: 32 })
    await nextEventLoop()
    expect(rig.emitted[0]).toBe('\uD5CC')
  })

  it('clears the overlay when the pane disposes the controller', async () => {
    // Dispose before xterm tears down DOM so held syllables do not remain painted over dead panes.
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, '\u314E', '\u314E', { replaces: false })
    expect(rig.compositionView.classList.contains('active')).toBe(true)

    rig.preedit.dispose()

    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.textContent).toBe('')
  })

  it('discards the open syllable on Escape, as a composition does', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchKey(rig, 'keydown', { key: 'Escape', code: 'Escape', keyCode: 27 })
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.textarea.value).toBe('')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('sends a jamo the IME never composed, once the next keydown settles it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    await nextEventLoop()

    // Device input arrives after a macrotask; timer-based fallback would send raw jamo before the rewrite.
    expect(rig.emitted).toEqual([])

    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })
    expect(rig.emitted).toEqual(['ㅎ', '\r'])
  })

  it('holds the jamo when the write lands after a full event loop turn', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    await nextEventLoop()

    // The shape the device produces: the field is written only after the turn.
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'insertText', 'ㅎ')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.compositionView.textContent).toBe('ㅎ')
  })

  it('keeps a screen reader on its existing path, so input cannot vanish', async () => {
    pretendIosWeb()
    const rig = openIosTerminal({ screenReaderMode: true })
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    expect(rig.preedit.heldText()).toBe('')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('leaves the syllable held when an input event changes nothing', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    await typeJamo(rig, 'ㅏ', '하', { replaces: true })

    // A rewrite that lands on the same text is not the IME finishing `하`.
    dispatchInput(rig, 'insertText', '하')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('하')
  })

  it('does not commit a held syllable the field has stopped showing', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    // Non-extension rewrites respell the syllable; the opening jamo is no longer owed separately.
    rig.textarea.value = '가나'
    dispatchInput(rig, 'insertText', '가나')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('가나')
  })

  it('commits the held syllable when the field is rewritten out from under it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)

    // External field replacement loses the comparison basis, so commit the held syllable instead of dropping it.
    rig.textarea.value = 'ls'
    dispatchInput(rig, 'insertText', 's')
    await nextEventLoop()

    expect(rig.emitted).toEqual(['한', '글'])
    expect(rig.preedit.heldText()).toBe('')
  })

  it('sends a jamo composed inside a session once, not twice', async () => {
    // On-screen Hangul has real sessions; gate by session state rather than unreliable keydown isComposing to avoid duplicate commits.
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchComposition(rig, 'compositionstart', '')
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    dispatchComposition(rig, 'compositionupdate', 'ㅎ')
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'insertCompositionText', 'ㅎ', { isComposing: true })
    dispatchKey(rig, 'keydown', { key: 'ㅏ', keyCode: 'ㅏ'.charCodeAt(0) })
    dispatchComposition(rig, 'compositionupdate', '하')
    rig.textarea.value = '하'
    dispatchInput(rig, 'insertCompositionText', '하', { isComposing: true })
    dispatchComposition(rig, 'compositionend', '하')
    dispatchInput(rig, 'insertCompositionText', '하')
    await nextEventLoop()
    await nextEventLoop()

    expect(rig.emitted).toEqual(['하'])
  })

  it('claims the field write even once the key has been released', async () => {
    // Late input after keyup bypasses xterm’s held-key guard; ownership must still prevent a second send.
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    dispatchKey(rig, 'keyup', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'insertText', 'ㅎ')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('ㅎ')
  })

  it('stands aside for composition-owned input without consulting session state', async () => {
    // Read ownership from the event so listener ordering cannot decide who commits.
    pretendIosWeb()
    const rig = openIosTerminal({ isCompositionActive: () => false })
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    rig.textarea.value = 'ㅎ하'
    dispatchInput(rig, 'insertCompositionText', '하')
    await nextEventLoop()

    expect(rig.emitted).toEqual(['ㅎ'])
    expect(rig.preedit.heldText()).toBe('')
  })

  it('stands aside for a composition that starts over an open syllable', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchComposition(rig, 'compositionstart', '')

    expect(rig.emitted).toEqual(['ㅎ'])
    expect(rig.preedit.heldText()).toBe('')
  })
})
