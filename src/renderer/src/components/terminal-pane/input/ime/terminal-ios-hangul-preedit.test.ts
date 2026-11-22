// @vitest-environment happy-dom
/** iPad hardware Hangul rewrites its textarea without composition events (#13345); xterm otherwise sends raw jamo and drops composed input. Exercise the pane’s real tracker, bypass and preedit stack. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disposeOpenTerminals,
  dispatchInput,
  dispatchKey,
  nextEventLoop,
  openIosTerminal,
  pretendIosWeb,
  typeHangeul,
  typeJamo
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
})
