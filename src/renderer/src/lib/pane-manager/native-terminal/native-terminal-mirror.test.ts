import { describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { installNativeTerminalMirror } from './native-terminal-mirror'

type FakeTerminal = {
  write: (data: string | Uint8Array, callback?: () => void) => void
  clear: () => void
  focus: () => void
  parsed: string[]
  callbacks: (() => void)[]
  flush: () => void
}

function fakeTerminal(): FakeTerminal {
  const fake: FakeTerminal = {
    parsed: [],
    callbacks: [],
    write(data, callback) {
      fake.parsed.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      if (callback) {
        fake.callbacks.push(callback)
      }
    },
    clear: vi.fn(),
    focus: vi.fn(),
    flush() {
      const pending = fake.callbacks.splice(0)
      for (const callback of pending) {
        callback()
      }
    }
  }
  return fake
}

function asTerminal(fake: FakeTerminal): Terminal {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror only touches write/clear/focus, which the fake implements.
  return fake as unknown as Terminal
}

function headlessAsTerminal(terminal: HeadlessTerminal): Terminal {
  // Headless xterm has no DOM focus; the mirror only wraps it.
  Reflect.set(terminal, 'focus', vi.fn())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror only touches write/clear/focus (focus stubbed above); headless xterm shares the core write buffer under test.
  return terminal as unknown as Terminal
}

describe('installNativeTerminalMirror', () => {
  it('does not forward anything before a surface is attached', () => {
    const fake = fakeTerminal()
    const send = vi.fn()
    installNativeTerminalMirror(asTerminal(fake), send)
    fake.write('before')
    expect(send).not.toHaveBeenCalled()
    expect(fake.parsed).toEqual(['before'])
  })

  it('seeds with a snapshot, then the bytes written while seeding, then live output', () => {
    const fake = fakeTerminal()
    const send = vi.fn()
    const mirror = installNativeTerminalMirror(asTerminal(fake), send)
    mirror.attach(7, () => 'SNAPSHOT')
    fake.write('during')
    expect(send).not.toHaveBeenCalled()
    fake.flush()
    expect(send).toHaveBeenLastCalledWith(7, 'SNAPSHOTduring')
    fake.write('live')
    expect(send).toHaveBeenLastCalledWith(7, 'live')
  })

  it('keeps write arity 2 for the output pipeline', () => {
    const fake = fakeTerminal()
    installNativeTerminalMirror(asTerminal(fake), vi.fn())
    expect(fake.write.length).toBe(2)
  })

  it('skips empty probe writes', () => {
    const fake = fakeTerminal()
    const send = vi.fn()
    const mirror = installNativeTerminalMirror(asTerminal(fake), send)
    mirror.attach(1, () => '')
    fake.flush()
    send.mockClear()
    fake.write('')
    expect(send).not.toHaveBeenCalled()
  })

  it('re-seeds from a reset after clear()', () => {
    const fake = fakeTerminal()
    const send = vi.fn()
    const mirror = installNativeTerminalMirror(asTerminal(fake), send)
    mirror.attach(3, () => 'S')
    fake.flush()
    fake.clear()
    fake.flush()
    expect(send).toHaveBeenLastCalledWith(3, '\x1bcS')
  })

  it('keeps DOM focus on xterm and then hands the keyboard to the native view', () => {
    const fake = fakeTerminal()
    const originalFocus = fake.focus
    const mirror = installNativeTerminalMirror(asTerminal(fake), vi.fn())
    const focusNative = vi.fn(() => true)
    mirror.setFocusTarget(focusNative)
    fake.focus()
    expect(originalFocus).toHaveBeenCalledTimes(1)
    expect(focusNative).toHaveBeenCalledTimes(1)
    mirror.focusShadow()
    expect(originalFocus).toHaveBeenCalledTimes(2)
    expect(focusNative).toHaveBeenCalledTimes(1)
  })

  it('hands the keyboard back to the page when no native view on screen takes it', () => {
    const fake = fakeTerminal()
    const releaseKeyboard = vi.fn()
    const mirror = installNativeTerminalMirror(asTerminal(fake), vi.fn(), releaseKeyboard)
    fake.focus()
    expect(releaseKeyboard).toHaveBeenCalledTimes(1)
    mirror.setFocusTarget(() => false)
    fake.focus()
    expect(releaseKeyboard).toHaveBeenCalledTimes(2)
    mirror.setFocusTarget(() => true)
    fake.focus()
    mirror.focusShadow()
    expect(releaseKeyboard).toHaveBeenCalledTimes(2)
  })

  it('drops a stale seed when detached before the marker parses', () => {
    const fake = fakeTerminal()
    const send = vi.fn()
    const mirror = installNativeTerminalMirror(asTerminal(fake), send)
    mirror.attach(5, () => 'S')
    mirror.detach()
    fake.flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('forwards nothing while main feeds the surface, and re-seeds with a reset on fallback', () => {
    const fake = fakeTerminal()
    const send = vi.fn()
    const mirror = installNativeTerminalMirror(asTerminal(fake), send)
    mirror.followMain(4)
    fake.write('from the PTY')
    fake.clear()
    fake.flush()
    expect(send).not.toHaveBeenCalled()
    expect(mirror.getSurfaceId()).toBe(4)
    mirror.attach(4, () => 'S', true)
    fake.flush()
    expect(send).toHaveBeenCalledWith(4, '\x1bcS')
  })

  it('still seeds when xterm resizes before the marker parses', () => {
    const terminal = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true })
    const send = vi.fn()
    const mirror = installNativeTerminalMirror(headlessAsTerminal(terminal), send)
    terminal.write('before\r\n')
    mirror.attach(9, () => 'SNAPSHOT')
    terminal.write('after\r\n')
    // Ghostty's first grid report resizes xterm, which flushes the queue synchronously.
    terminal.resize(40, 10)
    expect(send).toHaveBeenCalledWith(9, 'SNAPSHOTafter\r\n')
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('after')
    terminal.dispose()
  })
})
