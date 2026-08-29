// @vitest-environment happy-dom
// The release oracle: exact outbound bytes from the REAL shared
// forwarder behind installPreviewImeBridge. A wiring-only mock cannot show that
// a Preview opened on a bit-3 TUI commits CSI-u, nor that exactly one release
// leaves the forwarder in either macOS event order.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPreviewImeBridge } from './preview-terminal-ime-bridge'

vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => 'darwin'
}))

const COMMA = { key: ',', code: 'Comma', keyCode: 188 }

type Session = {
  emitted: string[]
  flagReads: number
  setFlags: (flags: number) => void
  keydown: (init?: { shiftKey?: boolean; repeat?: boolean; key?: string; code?: string }) => void
  keyup: (init?: { shiftKey?: boolean; key?: string; code?: string }) => void
  commit: (text: string) => void
  /** An input event the text system produced without committing text. */
  swallow: () => void
  xtermKittyFlags: () => number
  dispose: () => void
}

function open(initialFlags: number): Session {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea!
  let flags = initialFlags
  let flagReads = 0
  const bridge = installPreviewImeBridge(terminal, {
    getKittyKeyboardFlags: () => {
      flagReads += 1
      return flags
    }
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
    get flagReads() {
      return flagReads
    },
    setFlags: (next) => {
      flags = next
    },
    keydown: (init = {}) => key('keydown', init),
    keyup: (init = {}) => key('keyup', init),
    commit: (text) => input(text),
    swallow: () => input(null),
    xtermKittyFlags: () =>
      (
        terminal as unknown as {
          _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
        }
      )._core?.coreService?.kittyKeyboard?.flags ?? 0,
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

  // The bug: the bridge omitted getKittyKeyboardFlags entirely, so every commit
  // was evaluated at flags 0 and a bit-3 TUI received the legacy text it declined.
  it('encodes the commit from the flags proven before any live output', () => {
    const session = open(8)
    session.keydown()
    session.commit('，')
    session.keyup()
    expect(session.emitted.join('')).toBe('\x1b[44u')
    session.dispose()
  })

  describe.each([
    ['keydown -> insertText -> keyup', false],
    // An ordering some macOS input sources use; the earlier design cleared the
    // claimed press here, so the later commit could never be encoded as CSI-u.
    ['keydown -> keyup -> insertText', true]
  ])('in %s order', (_name, keyupFirst) => {
    const type = (session: Session): void => {
      session.keydown()
      if (keyupFirst) {
        session.keyup()
        session.commit('，')
      } else {
        session.commit('，')
        session.keyup()
      }
    }

    it.each([
      ['no flags', 0, '，'],
      ['disambiguate only', 1, '，'],
      ['event types', 2, '，\x1b[44;1:3u'],
      ['all keys as escape codes', 8, '\x1b[44u'],
      ['all keys + event types', 10, '\x1b[44u\x1b[44;1:3u']
    ])('emits the %s byte shape', (_flagName, flags, expected) => {
      const session = open(flags)
      type(session)
      expect(session.emitted.join('')).toBe(expected)
      session.dispose()
    })

    it('owns the release even though xterm holds no kitty state', () => {
      const session = open(10)
      // The forwarder must not delegate the keyup: Preview deliberately never
      // restores kitty flags into xterm, so xterm would emit nothing here.
      expect(session.xtermKittyFlags()).toBe(0)
      type(session)
      expect(session.emitted.join('')).toBe('\x1b[44u\x1b[44;1:3u')
      session.dispose()
    })

    it('reads the mutable getter exactly once, at commit time', () => {
      const session = open(0)
      session.keydown()
      expect(session.flagReads).toBe(0)
      session.setFlags(8)
      if (keyupFirst) {
        session.keyup()
        expect(session.flagReads).toBe(0)
        session.commit('，')
      } else {
        session.commit('，')
        session.keyup()
      }
      expect(session.flagReads).toBe(1)
      // The commit-time read is what both the press AND its release encode from.
      expect(session.emitted.join('')).toBe('\x1b[44u')
      session.dispose()
    })

    it('emits nothing when the input source swallowed the press', () => {
      const session = open(10)
      session.keydown()
      if (keyupFirst) {
        session.keyup()
        session.swallow()
      } else {
        session.swallow()
        session.keyup()
      }
      // A release describes a press the app received; none did.
      expect(session.emitted.join('')).toBe('')
      session.dispose()
    })
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
    // The repeat requested no event types, but its commit must not erase the
    // release the delivered first press still owes under the flags it was
    // sent with.
    expect(session.emitted.join('')).toBe('\x1b[44u\x1b[44u\x1b[44;1:3u')
    session.dispose()
  })

  it('suppresses the owed release when event types are no longer negotiated at keyup', () => {
    // xterm parity: KittyKeyboard.evaluate drops RELEASE reports the moment
    // report_event_types is gone, so an app that popped the mode — or the
    // successor shell of a TUI that quit on this very key — never receives
    // CSI-u bytes it did not negotiate.
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
