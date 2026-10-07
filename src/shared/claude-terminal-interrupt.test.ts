import { describe, expect, it, vi } from 'vitest'
import { ClaudeTerminalInterruptTracker } from './claude-terminal-interrupt'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

function createTracker() {
  let row: AgentHookEventPayload = {
    paneKey: 'pane',
    connectionId: null,
    payload: { agentType: 'claude', state: 'working', prompt: 'task' }
  }
  const interrupt = vi.fn()
  const tracker = new ClaudeTerminalInterruptTracker(() => row, interrupt)
  return {
    tracker,
    interrupt,
    replace: (next: AgentHookEventPayload) => {
      row = next
    },
    row
  }
}

describe('Claude native interruption evidence', () => {
  it.each(['\x1b', '\x1b[27u', '\x1b[27;1u', '\x1b[27;1:1u'])(
    'accepts a plain Escape press encoded as %j',
    (data) => {
      const { tracker, interrupt } = createTracker()
      tracker.observe('pane', { kind: 'title', title: '◐ Task' })
      tracker.observe('pane', { kind: 'input', data })
      tracker.observe('pane', { kind: 'input', data: '\x1b[27;1:2u' })
      tracker.observe('pane', { kind: 'input', data: '\x1b[27;1:3u' })
      tracker.observe('pane', { kind: 'title', title: '✳ Task' })
      expect(interrupt).toHaveBeenCalledOnce()
    }
  )

  it.each(['\x1b[27;2u', '\x1b[27;3u', '\x1b[27;5u', '\x1b[27;1:3u', '\x1b[?1u'])(
    'rejects modified Escape, release-only input and terminal replies: %j',
    (data) => {
      const { tracker, interrupt } = createTracker()
      tracker.observe('pane', { kind: 'title', title: '◐ Task' })
      tracker.observe('pane', { kind: 'input', data })
      tracker.observe('pane', { kind: 'title', title: '✳ Task' })
      expect(interrupt).not.toHaveBeenCalled()
    }
  )

  it('uses native glyphs regardless of title language', () => {
    const { tracker, interrupt } = createTracker()
    tracker.observe('pane', { kind: 'title', title: '◐ 長いテーブル' }, 100)
    tracker.observe('pane', { kind: 'input', data: '\x1b' }, 200)
    tracker.observe('pane', { kind: 'title', title: '✳ 長いテーブル' }, 262)
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it('expires an Escape instead of attributing a later completion to it', () => {
    const { tracker, interrupt } = createTracker()
    tracker.observe('pane', { kind: 'title', title: '◐ Task' }, 100)
    tracker.observe('pane', { kind: 'input', data: '\x1b' }, 200)
    tracker.observe('pane', { kind: 'title', title: '✳ Task' }, 5_201)
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('does not use words or a cleared progress indicator as idle evidence', () => {
    const { tracker, interrupt } = createTracker()
    tracker.observe('pane', { kind: 'title', title: '◐ Task' })
    tracker.observe('pane', { kind: 'input', data: '\x1b' })
    tracker.observe('pane', { kind: 'title', title: 'Claude done' })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it.each([
    { restoredUnconfirmed: true as const },
    { isReplay: true },
    { providerSessionOnly: true },
    { structuredHost: 'owned' as const }
  ])('rejects non-live terminal rows: %j', (flags) => {
    const { tracker, interrupt, replace, row } = createTracker()
    replace({ ...row, ...flags })
    tracker.observe('pane', { kind: 'title', title: '◐ Task' })
    tracker.observe('pane', { kind: 'input', data: '\x1b' })
    tracker.observe('pane', { kind: 'title', title: '✳ Task' })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('does not reuse a busy title from a previous turn', () => {
    const { tracker, interrupt, replace, row } = createTracker()
    replace({
      ...row,
      payload: { ...row.payload, mainAgent: { state: 'working', stateStartedAt: 100 } }
    })
    tracker.observe('pane', { kind: 'title', title: '◐ Task' }, 100)
    replace({
      ...row,
      payload: { ...row.payload, mainAgent: { state: 'working', stateStartedAt: 200 } }
    })
    tracker.observe('pane', { kind: 'input', data: '\x1b' }, 200)
    tracker.observe('pane', { kind: 'title', title: '✳ Task' }, 262)
    expect(interrupt).not.toHaveBeenCalled()
  })
})
