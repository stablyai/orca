// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { Terminal as EsmTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { shouldSuppressTerminalImeKeyboardEvent } from './xterm-bypass-policy'

const requireFromHere = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = requireFromHere('@xterm/xterm') as {
  Terminal: typeof EsmTerminal
}

describe.each([
  ['ESM', EsmTerminal],
  ['CJS', CjsTerminal]
])('standalone macOS IME keydown (%s)', (_format, TerminalType) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it.each(
    [0, 1, 9, 31].flatMap((flags) => [
      { flags, startsComposition: false },
      { flags, startsComposition: true }
    ])
  )(
    'preserves IME input: $flags, composition=$startsComposition',
    async ({ flags, startsComposition }) => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const terminal = new TerminalType()
      terminal.open(container)
      const textarea = terminal.textarea!
      const emitted: string[] = []
      terminal.onData((data) => emitted.push(data))
      const forwarder = installTerminalImeNativeTextForwarder({
        terminalElement: terminal.element,
        isComposing: () => false,
        sendInput: (data) => terminal.input(data),
        getKittyKeyboardFlags: () => flags
      })
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          shouldSuppressTerminalImeKeyboardEvent(event, {
            compositionActive: false,
            candidateKeyGuardActive: false,
            pendingCandidateKeyReleaseActive: false,
            isMac: true,
            isLinux: false
          })
        ) {
          return false
        }
        return !forwarder.claimKeyEvent(event)
      })

      try {
        await new Promise<void>((resolve) => terminal.write(`\x1b[>${flags}u`, resolve))
        const event = new KeyboardEvent('keydown', {
          key: 'ㅎ',
          code: 'KeyG',
          isComposing: false,
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(event, 'keyCode', { value: 229 })
        textarea.dispatchEvent(event)
        if (startsComposition) {
          textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
          for (const data of ['ㅎ', '하', '한']) {
            textarea.dispatchEvent(
              new CompositionEvent('compositionupdate', { data, bubbles: true })
            )
            textarea.value = data
            textarea.setSelectionRange(1, 1)
            textarea.dispatchEvent(
              new InputEvent('input', {
                data,
                inputType: 'insertCompositionText',
                isComposing: true,
                bubbles: true
              })
            )
          }
          textarea.dispatchEvent(
            new CompositionEvent('compositionend', { data: '한', bubbles: true })
          )
        } else {
          // The standalone-229 fallback observes native textarea changes without a composition session.
          textarea.value = 'ㅎ'
          textarea.setSelectionRange(1, 1)
        }
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(event.defaultPrevented).toBe(false)
        expect(emitted.join('')).toBe(startsComposition ? '한' : 'ㅎ')
      } finally {
        forwarder.dispose()
        terminal.dispose()
      }
    }
  )
})
