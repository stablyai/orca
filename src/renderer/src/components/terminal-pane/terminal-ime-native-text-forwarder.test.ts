// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import {
  isImeNativeTextKeydownCandidate,
  type ImeNativeTextKeyEvent
} from './terminal-ime-native-text-candidates'
import type { MacNativeTextInputSourceFeatures } from './terminal-ime-input-source'

const CJK_FEATURES = {
  forwardAsciiPunctuation: true,
  forwardShortTextReplacements: false
} satisfies MacNativeTextInputSourceFeatures

const VIETNAMESE_FEATURES = {
  forwardAsciiPunctuation: false,
  forwardShortTextReplacements: true
} satisfies MacNativeTextInputSourceFeatures

const DISABLED_FEATURES = {
  forwardAsciiPunctuation: false,
  forwardShortTextReplacements: false
} satisfies MacNativeTextInputSourceFeatures

function keyEvent(overrides: Partial<ImeNativeTextKeyEvent>): ImeNativeTextKeyEvent {
  return {
    type: 'keydown',
    key: ',',
    code: 'Comma',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    ...overrides
  }
}

function dispatchInsertText(target: HTMLElement, data: string | null): void {
  target.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

describe('isImeNativeTextKeydownCandidate', () => {
  it('accepts unmodified ASCII punctuation keydown outside composition for CJK sources', () => {
    for (const key of [',', '.', '?', '!', ';', ':', '"', "'", '\\', '<', '>', '~', '@', '#']) {
      expect(isImeNativeTextKeydownCandidate(keyEvent({ key }), false, CJK_FEATURES)).toBe(true)
    }
  })

  it('rejects unmodified ASCII punctuation keydown without an input source gate', () => {
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: '.' }), false, DISABLED_FEATURES)).toBe(
      false
    )
  })

  it('accepts direct CJK punctuation keydown outside composition for CJK sources', () => {
    for (const key of ['，', '。', '、', '？', '！', '：', '；', '…']) {
      expect(isImeNativeTextKeydownCandidate(keyEvent({ key }), false, CJK_FEATURES)).toBe(true)
    }
  })

  it('accepts direct CJK punctuation keydown when the input source probe is stale', () => {
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: '，', code: 'Comma' }),
        false,
        DISABLED_FEATURES
      )
    ).toBe(true)
  })

  it('accepts Vietnamese short replacement keys without enabling punctuation', () => {
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'a', code: 'KeyA' }),
        false,
        VIETNAMESE_FEATURES
      )
    ).toBe(true)
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'D', code: 'KeyD' }),
        false,
        VIETNAMESE_FEATURES
      )
    ).toBe(true)
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: '9', code: 'Digit9' }),
        false,
        VIETNAMESE_FEATURES
      )
    ).toBe(true)
    expect(
      isImeNativeTextKeydownCandidate(keyEvent({ key: ',' }), false, VIETNAMESE_FEATURES)
    ).toBe(false)
  })

  it('accepts synthesized Unicode text keydowns without an input source gate', () => {
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'h', code: 'KeyA', keyCode: 0 }),
        false,
        DISABLED_FEATURES
      )
    ).toBe(true)
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'é', code: '', keyCode: 0 }),
        false,
        DISABLED_FEATURES
      )
    ).toBe(true)
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'Unidentified', code: 'Unidentified' }),
        false,
        DISABLED_FEATURES
      )
    ).toBe(true)
  })

  it('rejects letters, digits and whitespace keys for CJK punctuation forwarding', () => {
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: 'a' }), false, CJK_FEATURES)).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: 'Z' }), false, CJK_FEATURES)).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: '5' }), false, CJK_FEATURES)).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: ' ' }), false, CJK_FEATURES)).toBe(false)
  })

  it('rejects named keys and multi-codepoint keys', () => {
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: 'Enter' }), false, CJK_FEATURES)).toBe(
      false
    )
    expect(
      isImeNativeTextKeydownCandidate(keyEvent({ key: 'ArrowLeft' }), false, CJK_FEATURES)
    ).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: '👩‍💻' }), false, CJK_FEATURES)).toBe(
      false
    )
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'Enter', code: 'Enter', keyCode: 0 }),
        false,
        DISABLED_FEATURES
      )
    ).toBe(false)
  })

  it('rejects Ctrl/Alt/Meta chords but accepts shifted punctuation like "!"', () => {
    expect(
      isImeNativeTextKeydownCandidate(keyEvent({ key: ',', ctrlKey: true }), false, CJK_FEATURES)
    ).toBe(false)
    expect(
      isImeNativeTextKeydownCandidate(keyEvent({ key: ',', metaKey: true }), false, CJK_FEATURES)
    ).toBe(false)
    expect(
      isImeNativeTextKeydownCandidate(keyEvent({ key: ',', altKey: true }), false, CJK_FEATURES)
    ).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: '!' }), false, CJK_FEATURES)).toBe(true)
  })

  it('rejects keystrokes that belong to an active composition', () => {
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: ',', isComposing: true }),
        false,
        CJK_FEATURES
      )
    ).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: ',' }), true, CJK_FEATURES)).toBe(false)
  })

  it('rejects non keyboard event types', () => {
    expect(isImeNativeTextKeydownCandidate(keyEvent({ type: 'input' }), false, CJK_FEATURES)).toBe(
      false
    )
    expect(
      isImeNativeTextKeydownCandidate(keyEvent({ type: 'keypress' }), false, CJK_FEATURES)
    ).toBe(false)
    expect(isImeNativeTextKeydownCandidate(keyEvent({ type: 'keyup' }), false, CJK_FEATURES)).toBe(
      false
    )
  })

  it('does not treat Japanese text keys as punctuation candidates', () => {
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: 'あ' }), false, CJK_FEATURES)).toBe(
      false
    )
    expect(isImeNativeTextKeydownCandidate(keyEvent({ key: '語' }), false, CJK_FEATURES)).toBe(
      false
    )
  })

  it('rejects physical printable candidates when no native text source feature is active', () => {
    expect(
      isImeNativeTextKeydownCandidate(
        keyEvent({ key: 'a', code: 'KeyA' }),
        false,
        DISABLED_FEATURES
      )
    ).toBe(false)
  })
})

describe('installTerminalImeNativeTextForwarder', () => {
  let element: HTMLDivElement
  let textarea: HTMLTextAreaElement

  beforeEach(() => {
    document.body.replaceChildren()
    element = document.createElement('div')
    textarea = document.createElement('textarea')
    textarea.className = 'xterm-helper-textarea'
    element.appendChild(textarea)
    document.body.appendChild(element)
  })

  it('forwards the IME-committed full-width glyph from the input event', () => {
    const sendInput = vi.fn()
    const laterInputListener = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })
    element.addEventListener('input', laterInputListener, true)

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    textarea.value = '，'
    dispatchInsertText(textarea, '，')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    expect(laterInputListener).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
  })

  it('forwards Japanese direct punctuation committed from a punctuation key', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: '.' }))).toBe(true)
    dispatchInsertText(textarea, '。')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('。')
  })

  it('forwards CJK punctuation when the keydown already carries the transformed glyph', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: '。', code: 'Period' }))).toBe(true)
    dispatchInsertText(textarea, '。')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('。')
  })

  it('forwards a plain ASCII symbol unchanged when the IME does not convert it', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    dispatchInsertText(textarea, ',')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith(',')
  })

  it('does not forward input when no candidate keydown was claimed', () => {
    const sendInput = vi.fn()
    installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    dispatchInsertText(textarea, '😀')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('does not claim composing keystrokes', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => true,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('ignores composition input events even after a claimed keydown', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    textarea.dispatchEvent(
      new InputEvent('input', { data: '，', inputType: 'insertCompositionText', bubbles: true })
    )
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('clears pending forwarding when a Japanese composition input takes over', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    textarea.dispatchEvent(
      new InputEvent('input', { data: 'に', inputType: 'insertCompositionText', bubbles: true })
    )
    dispatchInsertText(textarea, '日本語')

    expect(sendInput).not.toHaveBeenCalled()
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
  })

  it('keeps pending forward after keyup for CJK punctuation until the committed input arrives', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '，')
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('drops pending forwarding when no input follows a claimed keyup', () => {
    vi.useFakeTimers()
    try {
      const sendInput = vi.fn()
      const forwarder = installTerminalImeNativeTextForwarder({
        terminalElement: element,
        isComposing: () => false,
        sendInput,
        getInputSourceFeatures: () => CJK_FEATURES
      })

      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      vi.advanceTimersByTime(100)
      dispatchInsertText(textarea, '，')

      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('only forwards a single input per claimed keydown', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    dispatchInsertText(textarea, '，')
    dispatchInsertText(textarea, '。')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('bypasses keypress without clearing the armed forward (avoids ASCII double-send)', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    // keydown → keypress → input is the native order after we let the keydown
    // through; keypress must be claimed (so xterm stays silent) yet preserve the
    // pending forward armed by the keydown.
    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '，')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('bypasses transformed keypresses even when the browser omits physical code', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => VIETNAMESE_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'á', code: undefined }))).toBe(
      true
    )
    dispatchInsertText(textarea, 'á')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('á')
  })

  it('forwards Vietnamese letter replacement text and suppresses matching key events', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => VIETNAMESE_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'á', code: 'KeyA' }))).toBe(
      true
    )
    dispatchInsertText(textarea, 'á')

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'a', code: 'KeyA' }))).toBe(true)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('á')
  })

  it('forwards Vietnamese source letters that commit unchanged', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => VIETNAMESE_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'x', code: 'KeyX' }))).toBe(true)
    dispatchInsertText(textarea, 'x')

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'x', code: 'KeyX' }))).toBe(true)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('x')
  })

  it('forwards Vietnamese VNI digit replacement text within the Vietnamese source gate', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => VIETNAMESE_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: '9', code: 'Digit9' }))).toBe(true)
    dispatchInsertText(textarea, 'đ')

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: '9', code: 'Digit9' }))).toBe(
      true
    )
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('đ')
  })

  it('forwards synthesized non-CJK text while ordinary input-source features are disabled', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => DISABLED_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'h', code: 'KeyA', keyCode: 0 }))).toBe(true)
    dispatchInsertText(textarea, 'hello')

    expect(
      forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'h', code: 'KeyA', keyCode: 0 }))
    ).toBe(true)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('hello')
  })

  it('does not claim Vietnamese replacement keys when modifier chords are held', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => VIETNAMESE_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA', metaKey: true }))).toBe(false)
    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA', ctrlKey: true }))).toBe(false)
    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA', altKey: true }))).toBe(false)
    dispatchInsertText(textarea, 'á')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('does not forward ordinary letters without a native replacement source', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => DISABLED_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(false)
    dispatchInsertText(textarea, 'á')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('still claims keyup after forwarding input so the kitty release sequence does not leak', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '，')

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('does not claim keypress or keyup when this forwarder did not claim the keydown', () => {
    const sendInput = vi.fn()
    let composing = true
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => composing,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    composing = false

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: ',' }))).toBe(false)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(false)
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('stops forwarding after dispose', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    forwarder.dispose()
    dispatchInsertText(textarea, '，')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('is a no-op when no terminal element is provided', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: null,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => CJK_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    expect(() => forwarder.dispose()).not.toThrow()
  })

  it('does not forward punctuation when input-source features are disabled', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => DISABLED_FEATURES
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('can become enabled after the input source changes to a Vietnamese IME', () => {
    const sendInput = vi.fn()
    let features: MacNativeTextInputSourceFeatures = DISABLED_FEATURES
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      getInputSourceFeatures: () => features
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(false)
    features = VIETNAMESE_FEATURES

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)
    dispatchInsertText(textarea, 'á')
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('á')
  })
})
