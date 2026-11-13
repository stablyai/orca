// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPreviewImeBridge } from './preview-terminal-ime-bridge'

vi.mock('@/lib/keyboard/shortcut-platform', () => ({
  getShortcutPlatform: () => 'darwin'
}))

const COMMA = { key: ',', code: 'Comma', keyCode: 188 }

type Session = {
  emitted: string[]
  setFlags: (flags: number) => void
  keydown: (init?: { shiftKey?: boolean; repeat?: boolean; key?: string; code?: string }) => void
  keyup: (init?: { shiftKey?: boolean; key?: string; code?: string }) => void
  commit: (text: string) => void
  dispose: () => void
}

function open(initialFlags: number): Session {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea!
  let flags = initialFlags
  const bridge = installPreviewImeBridge(terminal, {
    getKittyKeyboardFlags: () => flags
  })!
  terminal.attachCustomKeyEventHandler((event) => !bridge.claimKeyEvent(event))
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))

  const key = (
    type: string,
    init: { key?: string; code?: string; shiftKey?: boolean; repeat?: boolean }
  ): void => {
    const event = new KeyboardEvent(type, {
      key: init.key ?? COMMA.key,
      code: init.code ?? COMMA.code,
      shiftKey: init.shiftKey === true,
      repeat: init.repeat === true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(event, 'keyCode', { value: COMMA.keyCode })
    textarea.dispatchEvent(event)
  }

  const input = (data: string | null): void => {
    for (const type of ['beforeinput', 'input']) {
      const event = new InputEvent(type, { bubbles: true })
      Object.defineProperty(event, 'inputType', { value: 'insertText' })
      Object.defineProperty(event, 'data', { value: data })
      textarea.dispatchEvent(event)
    }
  }

  return {
    emitted,
    setFlags: (next) => {
      flags = next
    },
    keydown: (init = {}) => key('keydown', init),
    keyup: (init = {}) => key('keyup', init),
    commit: (text) => input(text),
    dispose: () => {
      bridge.dispose()
      terminal.dispose()
    }
  }
}

describe('preview IME bridge outbound bytes', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('encodes the release from the keyup state when Shift is released first', () => {
    const session = open(10)
    // `!` on Digit1: the press reports the base key with the Shift modifier.
    session.keydown({ key: '!', code: 'Digit1', shiftKey: true })
    session.commit('！')
    session.keyup({ key: '1', code: 'Digit1', shiftKey: false })
    // 49 is `1`; the release carries no modifier because none was held at release.
    expect(session.emitted.join('')).toBe('\x1b[49;2u\x1b[49;1:3u')
    session.dispose()
  })

  it('emits one release for a held key across auto-repeat', () => {
    const session = open(10)
    session.keydown()
    session.commit('，')
    session.keydown({ repeat: true })
    session.commit('，')
    session.keyup()
    // Press, repeat, then exactly one release for the single physical press.
    expect(session.emitted.join('')).toBe('\x1b[44u\x1b[44;1:2u\x1b[44;1:3u')
    session.dispose()
  })

  it('keeps an owed release when a later repeat commits under flags that owe none', () => {
    const session = open(10)
    session.keydown()
    session.commit('，')
    session.setFlags(8)
    session.keydown({ repeat: true })
    session.commit('，')
    session.setFlags(10)
    session.keyup()
    // A repeat’s new flags cannot erase the release owed by the originally delivered press.
    expect(session.emitted.join('')).toBe('\x1b[44u\x1b[44u\x1b[44;1:3u')
    session.dispose()
  })

  it('suppresses the owed release when event types are no longer negotiated at keyup', () => {
    // Match xterm: once event reporting is popped, do not send CSI-u releases to an app or successor shell that no longer negotiates them.
    const session = open(10)
    session.keydown()
    session.commit('，')
    session.setFlags(0)
    session.keyup()
    expect(session.emitted.join('')).toBe('\x1b[44u')
    session.dispose()
  })

  it('releases each key of a two-key rollover exactly once', () => {
    const session = open(10)
    session.keydown()
    session.commit('，')
    session.keydown({ key: '.', code: 'Period' })
    session.commit('。')
    session.keyup()
    session.keyup({ key: '.', code: 'Period' })
    expect(session.emitted.join('')).toBe('\x1b[44u\x1b[46u\x1b[44;1:3u\x1b[46;1:3u')
    session.dispose()
  })

  it('leaves no release behind when a claim is retired without committing', () => {
    const session = open(10)
    session.keydown()
    // The input source ate the first press; the next keydown retires it.
    session.keydown({ key: '.', code: 'Period' })
    session.commit('。')
    session.keyup()
    session.keyup({ key: '.', code: 'Period' })
    expect(session.emitted.join('')).toBe('\x1b[46u\x1b[46;1:3u')
    session.dispose()
  })

  it('synthesizes nothing on blur or disposal', () => {
    const session = open(10)
    session.keydown()
    session.commit('，')
    session.emitted.length = 0
    document.querySelector('.xterm')?.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    session.keyup()
    session.dispose()
    expect(session.emitted.join('')).toBe('')
  })
})
