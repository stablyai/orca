// @vitest-environment happy-dom
/** macOS 2-Set right after an input-source switch: plain-commits ㅇ, then rebuilds it as 아 by replacing it (#9738, m4air trace). */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { installTerminalImeRetainedHangulCommit } from './terminal-ime-retained-hangul-commit'

function open(options: { trackTerminalData: boolean } = { trackTerminalData: false }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea!
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => false,
    sendInput: (data) => terminal.input(data),
    getKittyKeyboardFlags: () => 0,
    subscribeToTerminalData: options.trackTerminalData
      ? (listener) => terminal.onData(listener)
      : undefined
  })
  terminal.attachCustomKeyEventHandler((event) => !forwarder.claimKeyEvent(event))
  const emitted: string[] = []
  terminal.onData((d) => emitted.push(d))
  return { emitted, terminal, textarea, forwarder, container }
}

function keydown(textarea: HTMLTextAreaElement, key: string, code: string, keyCode: number) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, bubbles: true }))
}

function plainCommit(textarea: HTMLTextAreaElement, data: string) {
  textarea.setRangeText(data, textarea.selectionStart, textarea.selectionEnd, 'end')
  textarea.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

// Blink selects the replacement range, fires beforeinput, then writes the text.
function replacingCommit(textarea: HTMLTextAreaElement, start: number, end: number, data: string) {
  textarea.setSelectionRange(start, end)
  textarea.dispatchEvent(
    new InputEvent('beforeinput', { data, inputType: 'insertText', bubbles: true })
  )
  plainCommit(textarea, data)
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data?: string
) {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

// Blink writes the composing range, then fires input(insertCompositionText).
function compositionText(textarea: HTMLTextAreaElement, start: number, text: string) {
  composition(textarea, 'compositionupdate', text)
  textarea.value = textarea.value.slice(0, start) + text
  textarea.setSelectionRange(start + text.length, start + text.length)
  textarea.dispatchEvent(
    new InputEvent('input', { data: text, inputType: 'insertCompositionText', bubbles: true })
  )
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

describe('#9738 plain-committed jamo rebuilt in place', () => {
  let pane: ReturnType<typeof open>

  beforeEach(() => {
    // happy-dom has no canvas, and xterm measures text on open().
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only calls measureText on this stub.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
    pane = open()
  })

  afterEach(() => {
    pane.forwarder.dispose()
    pane.terminal.dispose()
    pane.container.remove()
    vi.restoreAllMocks()
  })

  it('keeps the jamo for the rebuild and erases it from the PTY when replaced', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')
    expect(pane.textarea.value).toBe('ㅇ')

    keydown(pane.textarea, 'ㅏ', 'KeyK', 75)
    replacingCommit(pane.textarea, 0, 1, '아')

    expect(pane.emitted.join('')).toBe('ㅇ\x7f아')
  })

  it('erases the jamo before a composition that replaces it begins', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.setSelectionRange(0, 1)
    pane.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

    expect(pane.emitted.join('')).toBe('ㅇ\x7f')
  })

  it('does not erase for an edit whose replacement never reaches the PTY', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.setSelectionRange(0, 1)
    pane.textarea.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertReplacementText', bubbles: true })
    )

    expect(pane.emitted.join('')).toBe('ㅇ')
  })

  it('does not erase once an ordinary composition has begun after the jamo', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    pane.textarea.setSelectionRange(0, 1)
    pane.textarea.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertCompositionText', bubbles: true })
    )

    expect(pane.emitted.join('')).toBe('ㅇ')
  })

  it('removes the jamo from the field on Ctrl+C the pane handles ahead of the forwarder', () => {
    pane.terminal.attachCustomKeyEventHandler(
      (event) => !event.ctrlKey && !pane.forwarder.claimKeyEvent(event)
    )
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        keyCode: 67,
        ctrlKey: true,
        bubbles: true
      })
    )

    expect(pane.textarea.value).toBe('')
  })

  describe('with terminal data tracked, as on macOS', () => {
    beforeEach(() => {
      pane.forwarder.dispose()
      pane.terminal.dispose()
      pane.container.remove()
      pane = open({ trackTerminalData: true })
    })

    // Chromium fires the next keydown while the previous syllable still composes, so the forwarder never claims it.
    function composeThenPlainCommitDuringComposition() {
      keydown(pane.textarea, 'ㅈ', 'KeyW', 229)
      composition(pane.textarea, 'compositionstart')
      compositionText(pane.textarea, 0, '전')
      pane.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ㅎ',
          code: 'KeyG',
          keyCode: 229,
          isComposing: true,
          bubbles: true
        })
      )
      composition(pane.textarea, 'compositionend', '전')
      plainCommit(pane.textarea, 'ㅎ')
    }

    it('erases a jamo xterm delivered because its keydown arrived mid-composition', async () => {
      composeThenPlainCommitDuringComposition()
      await nextEventLoop()

      keydown(pane.textarea, 'ㅏ', 'KeyK', 229)
      pane.textarea.setSelectionRange(1, 2)
      composition(pane.textarea, 'compositionstart')
      compositionText(pane.textarea, 1, '하')
      composition(pane.textarea, 'compositionend', '하')
      await nextEventLoop()

      expect(pane.emitted.join('')).toBe('전ㅎ\x7f하')
    })

    it('erases a claimed jamo that the pending composition finalizer delivered', async () => {
      keydown(pane.textarea, 'ㅈ', 'KeyW', 229)
      composition(pane.textarea, 'compositionstart')
      compositionText(pane.textarea, 0, '전')
      composition(pane.textarea, 'compositionend', '전')
      // Claimed, but lands while the 전 transaction is accepted and not yet settled.
      keydown(pane.textarea, 'ㅎ', 'KeyG', 71)
      plainCommit(pane.textarea, 'ㅎ')
      await nextEventLoop()

      keydown(pane.textarea, 'ㅏ', 'KeyK', 229)
      pane.textarea.setSelectionRange(1, 2)
      composition(pane.textarea, 'compositionstart')
      compositionText(pane.textarea, 1, '하')
      composition(pane.textarea, 'compositionend', '하')
      await nextEventLoop()

      expect(pane.emitted.join('')).toBe('전ㅎ\x7f하')
    })

    it('erases both when a rebuild spans a jamo xterm delivered and one the forwarder sent', async () => {
      composeThenPlainCommitDuringComposition()
      await nextEventLoop()
      keydown(pane.textarea, 'ㅏ', 'KeyK', 75)
      plainCommit(pane.textarea, 'ㅏ')

      keydown(pane.textarea, 'ㄴ', 'KeyS', 83)
      replacingCommit(pane.textarea, 1, 3, '한')

      expect(pane.emitted.join('')).toBe('전ㅎㅏ\x7f\x7f한')
    })
  })
})

describe('retaining a jamo xterm sends', () => {
  it('erases it only after the terminal data shows it was sent', () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.appendChild(textarea)
    document.body.appendChild(element)
    const sent: string[] = []
    let terminalData: (data: string) => void = () => undefined
    const retained = installTerminalImeRetainedHangulCommit({
      terminalElement: element,
      sendInput: (data) => sent.push(data),
      getKittyKeyboardFlags: () => 0,
      subscribeToTerminalData: (listener) => {
        terminalData = listener
        return { dispose: () => undefined }
      }
    })
    const commitJamoAfterSyllable = () => {
      textarea.value = '전'
      textarea.setSelectionRange(1, 1)
      plainCommit(textarea, 'ㅎ')
    }
    const beginRebuild = () => {
      textarea.setSelectionRange(1, 2)
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    }

    commitJamoAfterSyllable()
    // The pending syllable leaves without the jamo, so a rebuild now must not erase anything.
    terminalData('전')
    beginRebuild()
    expect(sent).toEqual([])

    commitJamoAfterSyllable()
    // Backspace flushes the pending text and erases the jamo from the PTY itself.
    keydown(textarea, 'Backspace', 'Backspace', 8)
    terminalData('전ㅎ')
    beginRebuild()
    expect(sent).toEqual([])

    commitJamoAfterSyllable()
    // The jamo is never sent and a mouse paste empties the field; ㅎㅎ is then typed as ordinary compositions.
    textarea.value = ''
    composition(textarea, 'compositionstart')
    compositionText(textarea, 0, 'ㅎ')
    composition(textarea, 'compositionend', 'ㅎ')
    composition(textarea, 'compositionstart')
    compositionText(textarea, 1, 'ㅎ')
    // The first ㅎ leaves while the second composes at the unsent jamo's offset.
    terminalData('ㅎ')
    textarea.setSelectionRange(1, 2)
    textarea.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertCompositionText', bubbles: true })
    )
    expect(sent).toEqual([])

    commitJamoAfterSyllable()
    terminalData('전ㅎ')
    beginRebuild()
    expect(sent).toEqual(['\x7f'])

    retained.dispose()
    element.remove()
  })
})
