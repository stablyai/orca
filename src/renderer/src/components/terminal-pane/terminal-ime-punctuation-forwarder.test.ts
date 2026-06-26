// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalImePunctuationForwarder,
  isImePunctuationCandidate,
  type ImePunctuationKeyEvent
} from './terminal-ime-punctuation-forwarder'

function keyEvent(overrides: Partial<ImePunctuationKeyEvent>): ImePunctuationKeyEvent {
  return {
    type: 'keydown',
    key: ',',
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

describe('isImePunctuationCandidate', () => {
  it('accepts unmodified ASCII punctuation keydown/keypress/keyup outside composition', () => {
    for (const key of [',', '.', '?', '!', ';', ':', '"', "'", '\\', '<', '>', '~', '@', '#']) {
      expect(isImePunctuationCandidate(keyEvent({ key }), false)).toBe(true)
      expect(isImePunctuationCandidate(keyEvent({ type: 'keypress', key }), false)).toBe(true)
      expect(isImePunctuationCandidate(keyEvent({ type: 'keyup', key }), false)).toBe(true)
    }
  })

  it('rejects letters, digits and whitespace keys', () => {
    expect(isImePunctuationCandidate(keyEvent({ key: 'a' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: 'Z' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: '5' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: ' ' }), false)).toBe(false)
  })

  it('rejects named keys and multi-codepoint keys', () => {
    expect(isImePunctuationCandidate(keyEvent({ key: 'Enter' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: 'ArrowLeft' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: '，' }), false)).toBe(false)
  })

  it('rejects Ctrl/Alt/Meta chords but accepts shifted punctuation like "!"', () => {
    expect(isImePunctuationCandidate(keyEvent({ key: ',', ctrlKey: true }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: ',', metaKey: true }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: ',', altKey: true }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: '!' }), false)).toBe(true)
  })

  it('rejects keystrokes that belong to an active composition', () => {
    expect(isImePunctuationCandidate(keyEvent({ key: ',', isComposing: true }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: ',' }), true)).toBe(false)
  })

  it('rejects non keyboard event types', () => {
    expect(isImePunctuationCandidate(keyEvent({ type: 'input' }), false)).toBe(false)
  })

  it('does not treat Japanese text or punctuation keys as ASCII punctuation candidates', () => {
    expect(isImePunctuationCandidate(keyEvent({ key: 'あ' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: '。' }), false)).toBe(false)
    expect(isImePunctuationCandidate(keyEvent({ key: '、' }), false)).toBe(false)
  })
})

describe('installTerminalImePunctuationForwarder', () => {
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
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
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
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: '.' }))).toBe(true)
    dispatchInsertText(textarea, '。')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('。')
  })

  it('forwards a plain ASCII symbol unchanged when the IME does not convert it', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    dispatchInsertText(textarea, ',')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith(',')
  })

  it('does not forward input when no candidate keydown was claimed', () => {
    const sendInput = vi.fn()
    installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    dispatchInsertText(textarea, '😀')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('does not claim composing keystrokes', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => true,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('ignores composition input events even after a claimed keydown', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    textarea.dispatchEvent(
      new InputEvent('input', { data: '，', inputType: 'insertCompositionText', bubbles: true })
    )
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('clears pending forwarding when a Japanese composition input takes over', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    textarea.dispatchEvent(
      new InputEvent('input', { data: 'に', inputType: 'insertCompositionText', bubbles: true })
    )
    dispatchInsertText(textarea, '日本語')

    expect(sendInput).not.toHaveBeenCalled()
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
  })

  it('clears the pending forward on a matching keyup so later inserts are not forwarded', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('only forwards a single input per claimed keydown', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    dispatchInsertText(textarea, '，')
    dispatchInsertText(textarea, '。')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('bypasses keypress without clearing the armed forward (avoids ASCII double-send)', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    // keydown → keypress → input is the native order after we let the keydown
    // through; keypress must be claimed (so xterm stays silent) yet preserve the
    // pending forward armed by the keydown.
    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '，')

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('still claims keyup after forwarding input so the kitty release sequence does not leak', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '，')

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
  })

  it('does not claim keypress or keyup when this forwarder did not claim the keydown', () => {
    const sendInput = vi.fn()
    let composing = true
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => composing,
      sendInput
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
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    forwarder.dispose()
    dispatchInsertText(textarea, '，')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('is a no-op when no terminal element is provided', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: null,
      isComposing: () => false,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    expect(() => forwarder.dispose()).not.toThrow()
  })

  it('is disabled outside the macOS IME workaround path', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      isEnabled: () => false
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('can become enabled after the input source changes to a CJK IME', () => {
    const sendInput = vi.fn()
    let enabled = false
    const forwarder = installTerminalImePunctuationForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput,
      isEnabled: () => enabled
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    enabled = true

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    dispatchInsertText(textarea, '、')
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('、')
  })
})
