import { afterEach, describe, expect, it, vi } from 'vitest'

// Why: the executor must yield through the shared helper by default, not a local setTimeout(0)
// that Chromium clamps once nested. Mocking the module pins the default's identity without
// depending on the helper's Vitest-only setTimeout fallback.
const { events, yieldToEventLoop } = vi.hoisted(() => {
  const events: string[] = []
  return {
    events,
    yieldToEventLoop: vi.fn(async () => {
      events.push('yield')
    })
  }
})

vi.mock('../../../../shared/event-loop-yield', () => ({ yieldToEventLoop }))

import { planTerminalPaste, type TerminalPasteTarget } from './terminal-paste-coordinator'
import { executeTerminalPastePlan } from './terminal-paste-executor'

const target: TerminalPasteTarget = {
  kind: 'terminal',
  paneId: 1,
  leafId: 'leaf-1',
  ptyId: 'pty-default-yield',
  runtime: { platform: 'linux', runtimeKey: 'local:linux', kind: 'local' }
}

function chunkedPlan() {
  return planTerminalPaste({
    text: '0123456789abcdef',
    source: 'keyboard',
    target,
    maxDirectBytes: 4,
    maxChunkBytes: 4
  })
}

afterEach(() => {
  events.length = 0
  yieldToEventLoop.mockClear()
  vi.restoreAllMocks()
})

describe('terminal paste executor default yield', () => {
  it('yields after every chunk through the shared event-loop helper, never a timer', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const writePty = vi.fn((chunk: string) => {
      events.push(`write:${chunk}`)
      return true
    })
    const plan = chunkedPlan()
    expect(plan.mode).toBe('chunked')

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => true,
      canContinue: () => true,
      // Why: 0 disables the per-operation timeout timer, so any setTimeout call would be a yield.
      operationTimeoutMs: 0
    })

    expect(result.status).toBe('pasted')
    expect(events).toEqual([
      'write:0123',
      'yield',
      'write:4567',
      'yield',
      'write:89ab',
      'yield',
      'write:cdef',
      'yield'
    ])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('re-checks the target after a default yield before writing the next chunk', async () => {
    let current = true
    yieldToEventLoop.mockImplementationOnce(async () => {
      events.push('yield')
      current = false
    })
    const writePty = vi.fn((chunk: string) => {
      events.push(`write:${chunk}`)
      return true
    })

    const result = await executeTerminalPastePlan(chunkedPlan(), {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => current,
      canContinue: () => true,
      operationTimeoutMs: 0
    })

    expect(result.status).toBe('cancelled')
    expect(result.reason).toBe('stale-target')
    expect(events).toEqual(['write:0123', 'yield'])
  })
})
