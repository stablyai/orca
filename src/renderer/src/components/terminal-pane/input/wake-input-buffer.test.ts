import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WAKE_INPUT_CAP,
  WAKE_INPUT_MAX_HOLD_MS,
  WAKE_INPUT_SETTLED_GRACE_MS,
  applyWakeInput,
  beginWorkspaceWake,
  captureWakeInput,
  clearWakeInput,
  endWorkspaceWake,
  getWakeInputCount,
  isWorkspaceWaking,
  paneHadUserInputSince,
  subscribeWakeInputDropped,
  pumpWakeInputForTests,
  rebindWakeInputTarget,
  resetWakeInputForTests,
  subscribeWakeInputDelivered
} from './wake-input-buffer'

const T = 1_800_000_000_000

beforeEach(() => {
  // The buffer stamps wake settlement with Date.now(); pin it so hold and grace math is exact.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T)
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

  it('inserts held typing once after re-attach, without ever replaying Enter', () => {
    const p = pane(false)
    const deliveries: boolean[] = []
    subscribeWakeInputDelivered((d) => void deliveries.push(d.submitted))
    beginWorkspaceWake('ws', T)
    expect(isWorkspaceWaking('ws')).toBe(true)
    expect(captureWakeInput('ws', 'leaf-1', 'ec', p.deliver, p.isReady)).toBe(true)
    expect(captureWakeInput('ws', 'leaf-1', 'ho hi\r', p.deliver, p.isReady)).toBe(true)
    expect(getWakeInputCount('ws')).toBe('echo hi'.length)
    pumpWakeInputForTests(T + 100)
    expect(p.delivered).toEqual([])
    p.state.ready = true
    pumpWakeInputForTests(T + 200)
    pumpWakeInputForTests(T + 300)
    expect(p.delivered).toEqual(['echo hi'])
    expect(deliveries).toEqual([true])
    expect(paneHadUserInputSince('leaf-1', T)).toBe(true)
  })

  it('keeps order for keys typed after the wake ends but before delivery', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'a', p.deliver, p.isReady)
    pumpWakeInputForTests(T)
    endWorkspaceWake('ws', 'ready')
    expect(captureWakeInput('ws', 'leaf-1', 'b', p.deliver, p.isReady)).toBe(true)
    p.state.ready = true
    pumpWakeInputForTests()
    expect(p.delivered).toEqual(['ab'])
    expect(captureWakeInput('ws', 'leaf-1', 'c', p.deliver, p.isReady)).toBe(false)
  })

  it('waits for the wake to settle when the transport never dropped (it may be the old attachment)', () => {
    const p = pane(true)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'x', p.deliver, p.isReady)
    pumpWakeInputForTests()
    expect(p.delivered).toEqual([])
    endWorkspaceWake('ws', 'ready')
    expect(p.delivered).toEqual(['x'])
  })

  it('drops held typing when the wake fails', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'rm -rf build\r', p.deliver, p.isReady)
    endWorkspaceWake('ws', 'failed')
    p.state.ready = true
    pumpWakeInputForTests()
    expect(p.delivered).toEqual([])
    expect(getWakeInputCount('ws')).toBe(0)
  })

  it('drops (never delivers) at the max hold when nobody settles the wake', () => {
    const p = pane(true)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'late', p.deliver, p.isReady)
    pumpWakeInputForTests(T + WAKE_INPUT_MAX_HOLD_MS + 1)
    expect(p.delivered).toEqual([])
    expect(isWorkspaceWaking('ws')).toBe(false)
  })

  it('drops typing a pane never re-attached to a while after the wake settles', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'ls', p.deliver, p.isReady)
    endWorkspaceWake('ws', 'ready')
    pumpWakeInputForTests(T + WAKE_INPUT_SETTLED_GRACE_MS + 1)
    p.state.ready = true
    pumpWakeInputForTests()
    expect(p.delivered).toEqual([])
    expect(getWakeInputCount('ws')).toBe(0)
  })

  it('never carries leftovers into the next wake', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'old', p.deliver, p.isReady)
    endWorkspaceWake('ws', 'ready')
    beginWorkspaceWake('ws', T + 60_000)
    expect(getWakeInputCount('ws')).toBe(0)
  })

  it('caps held typing, and × clears it', () => {
    const p = pane(false)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'a'.repeat(WAKE_INPUT_CAP + 100), p.deliver, p.isReady)
    expect(getWakeInputCount('ws')).toBe(WAKE_INPUT_CAP)
    clearWakeInput('ws')
    expect(getWakeInputCount('ws')).toBe(0)
  })

  it('keeps panes separate', () => {
    const a = pane(false)
    const b = pane(false)
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'one', a.deliver, a.isReady)
    captureWakeInput('ws', 'leaf-2', 'two', b.deliver, b.isReady)
    pumpWakeInputForTests(T)
    a.state.ready = true
    b.state.ready = true
    pumpWakeInputForTests(T + 1)
    expect(a.delivered).toEqual(['one'])
    expect(b.delivered).toEqual(['two'])
  })

  it('delivers through the newest session of the same leaf after a remount', () => {
    const delivered: { old: string[]; next: string[] } = { old: [], next: [] }
    let ready = false
    beginWorkspaceWake('ws', T)
    captureWakeInput(
      'ws',
      'leaf-1',
      'ls',
      (d) => void delivered.old.push(d),
      () => false
    )
    pumpWakeInputForTests(T)
    rebindWakeInputTarget(
      'ws',
      'leaf-1',
      (d) => void delivered.next.push(d),
      () => ready
    )
    ready = true
    pumpWakeInputForTests(T + 1)
    expect(delivered).toEqual({ old: [], next: ['ls'] })
  })
})

describe('applyWakeInput', () => {
  const apply = (data: string, text = '') => applyWakeInput({ text, submitted: false }, data)

  it('keeps plain text and Tab; notes Enter without keeping it', () => {
    expect(apply('git st\tatus\r')).toEqual({
      text: 'git st\tatus',
      submitted: true,
      multiline: false
    })
  })

  it('Backspace edits the held text and Ctrl-C clears it', () => {
    expect(apply('lss\x7f -la').text).toBe('ls -la')
    expect(apply('\x03', 'rm -rf /')).toEqual({
      text: '',
      submitted: false,
      multiline: false
    })
  })

  it('drops escape sequences (arrows, OSC, alt keys) and other controls', () => {
    expect(apply('a\x04b').text).toBe('ab')
    expect(apply('\x1b[A\x1b[1;5Cls').text).toBe('ls')
    expect(apply('\x1bOPx').text).toBe('x')
    expect(apply('\x1b]0;title\x07y').text).toBe('y')
    expect(apply('\x1bbz').text).toBe('z')
  })
})

describe('nothing joined, nothing lost silently', () => {
  it('drops a multi-line paste instead of joining its lines, and says so', () => {
    const p = pane(false)
    const dropped: string[] = []
    subscribeWakeInputDropped((d) => void dropped.push(d.workspaceId))
    beginWorkspaceWake('ws', T)
    captureWakeInput('ws', 'leaf-1', 'cd a\rgit pull', p.deliver, p.isReady)
    pumpWakeInputForTests(T)
    p.state.ready = true
    pumpWakeInputForTests(T + 1)
    expect(p.delivered).toEqual([])
    expect(dropped).toEqual(['ws'])
  })

  it('says so when held typing is dropped by a failed wake, the max hold or the grace', () => {
    const dropped: string[] = []
    subscribeWakeInputDropped((d) => void dropped.push(d.workspaceId))
    const p = pane(false)
    beginWorkspaceWake('a', T)
    captureWakeInput('a', 'leaf-1', 'x', p.deliver, p.isReady)
    endWorkspaceWake('a', 'failed')
    beginWorkspaceWake('b', T)
    captureWakeInput('b', 'leaf-1', 'x', p.deliver, p.isReady)
    pumpWakeInputForTests(T + WAKE_INPUT_MAX_HOLD_MS + 1)
    beginWorkspaceWake('c', T)
    captureWakeInput('c', 'leaf-1', 'x', p.deliver, p.isReady)
    endWorkspaceWake('c', 'ready')
    pumpWakeInputForTests(T + WAKE_INPUT_SETTLED_GRACE_MS + 1)
    expect(dropped.sort()).toEqual(['a', 'b', 'c'])
  })
})
