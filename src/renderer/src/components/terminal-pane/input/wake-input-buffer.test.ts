import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WAKE_INPUT_CAP,
  WAKE_INPUT_MAX_HOLD_MS,
  beginWorkspaceWake,
  captureWakeInput,
  endWorkspaceWake,
  getWakeInputPreview,
  isWorkspaceWaking,
  pumpWakeInputForTests,
  rebindWakeInputTarget,
  resetWakeInputForTests,
  sanitizeWakeInput
} from './wake-input-buffer'

describe('remount', () => {
  it('delivers through the newest session of the same leaf', () => {
    const delivered: { old: string[]; next: string[] } = { old: [], next: [] }
    let ready = false
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput(
      'ws',
      'leaf-1',
      'ls\r',
      (d) => void delivered.old.push(d),
      () => false
    )
    pumpWakeInputForTests()
    rebindWakeInputTarget(
      'ws',
      'leaf-1',
      (d) => void delivered.next.push(d),
      () => ready
    )
    ready = true
    pumpWakeInputForTests()
    expect(delivered).toEqual({ old: [], next: ['ls\r'] })
  })
})

afterEach(() => {
  resetWakeInputForTests()
  vi.useRealTimers()
})

function pane(ready = false) {
  const delivered: string[] = []
  const state = { ready }
  return {
    delivered,
    state,
    deliver: (data: string) => void delivered.push(data),
    isReady: () => state.ready
  }
}

describe('wake input buffer', () => {
  it('does nothing when the workspace is not waking', () => {
    const p = pane(true)
    expect(captureWakeInput('ws', 'leaf-1', 'ls', p.deliver, p.isReady)).toBe(false)
  })

  it('holds typing in order and delivers it exactly once after the pane re-attaches', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', Date.now())
    expect(isWorkspaceWaking('ws')).toBe(true)
    expect(captureWakeInput('ws', 'leaf-1', 'ec', p.deliver, p.isReady)).toBe(true)
    expect(captureWakeInput('ws', 'leaf-1', 'ho hi\r', p.deliver, p.isReady)).toBe(true)
    expect(getWakeInputPreview('ws')).toBe('echo hi\r')
    pumpWakeInputForTests()
    expect(p.delivered).toEqual([])
    p.state.ready = true
    pumpWakeInputForTests()
    pumpWakeInputForTests()
    expect(p.delivered).toEqual(['echo hi\r'])
    expect(getWakeInputPreview('ws')).toBe('')
  })

  it('keeps order for keys typed after the wake ends but before delivery', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput('ws', 'leaf-1', 'a', p.deliver, p.isReady)
    pumpWakeInputForTests()
    endWorkspaceWake('ws', 'ready')
    // Still not attached: later keys queue behind the held ones.
    expect(captureWakeInput('ws', 'leaf-1', 'b', p.deliver, p.isReady)).toBe(true)
    p.state.ready = true
    pumpWakeInputForTests()
    expect(p.delivered).toEqual(['ab'])
    // Delivered: the next key goes straight through.
    expect(captureWakeInput('ws', 'leaf-1', 'c', p.deliver, p.isReady)).toBe(false)
  })

  it('waits for the wake to settle when the transport never dropped (it may be the old attachment)', () => {
    const p = pane(true)
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput('ws', 'leaf-1', 'x', p.deliver, p.isReady)
    pumpWakeInputForTests()
    expect(p.delivered).toEqual([])
    endWorkspaceWake('ws', 'ready')
    expect(p.delivered).toEqual(['x'])
  })

  it('drops held typing when the wake fails', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput('ws', 'leaf-1', 'rm -rf build\r', p.deliver, p.isReady)
    endWorkspaceWake('ws', 'failed')
    p.state.ready = true
    pumpWakeInputForTests()
    expect(p.delivered).toEqual([])
    expect(getWakeInputPreview('ws')).toBe('')
  })

  it('caps held typing', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput('ws', 'leaf-1', 'a'.repeat(WAKE_INPUT_CAP + 100), p.deliver, p.isReady)
    expect(getWakeInputPreview('ws')).toHaveLength(WAKE_INPUT_CAP)
  })

  it('keeps panes separate', () => {
    const a = pane(false)
    const b = pane(false)
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput('ws', 'leaf-1', 'one', a.deliver, a.isReady)
    captureWakeInput('ws', 'leaf-2', 'two', b.deliver, b.isReady)
    pumpWakeInputForTests()
    a.state.ready = true
    b.state.ready = true
    pumpWakeInputForTests()
    expect(a.delivered).toEqual(['one'])
    expect(b.delivered).toEqual(['two'])
  })

  it('stops holding after the max hold if nobody settles the wake', () => {
    vi.useFakeTimers()
    const p = pane(true)
    beginWorkspaceWake('ws', Date.now())
    captureWakeInput('ws', 'leaf-1', 'late', p.deliver, p.isReady)
    vi.setSystemTime(Date.now() + WAKE_INPUT_MAX_HOLD_MS + 1)
    pumpWakeInputForTests()
    expect(p.delivered).toEqual(['late'])
    expect(isWorkspaceWaking('ws')).toBe(false)
  })
})

describe('sanitizeWakeInput', () => {
  it('keeps plain typing, Enter, Tab and Backspace', () => {
    expect(sanitizeWakeInput('git st\tatus\x7f\r')).toBe('git st\tatus\x7f\r')
  })

  it('drops Ctrl-C/Ctrl-D and other controls, and escape sequences (arrows, OSC, alt keys)', () => {
    expect(sanitizeWakeInput('a\x03b\x04c')).toBe('abc')
    expect(sanitizeWakeInput('\x1b[A\x1b[1;5Cls')).toBe('ls')
    expect(sanitizeWakeInput('\x1bOPx')).toBe('x')
    expect(sanitizeWakeInput('\x1b]0;title\x07y')).toBe('y')
    expect(sanitizeWakeInput('\x1bbz')).toBe('z')
  })
})
