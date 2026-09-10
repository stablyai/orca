// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type * as AgentSessionPrefixModule from '../../../../shared/agent-session-prefix'

const { activate, call, scanned, toastSuccess } = vi.hoisted(() => ({
  activate: vi.fn(),
  call: vi.fn(),
  scanned: vi.fn(),
  toastSuccess: vi.fn()
}))
// The real resolver, observed: the scan must not run mid-turn, but its RESULT is what the
// dedupe assertions below depend on, so a stub would prove nothing.
vi.mock('../../../../shared/agent-session-prefix', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionPrefixModule>()
  return {
    ...actual,
    structuredForkTurnAnchors: (items: readonly AgentJournalRenderItem[]) => {
      scanned()
      return actual.structuredForkTurnAnchors(items)
    }
  }
})
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: call,
  StructuredAgentSessionCapabilityError: class extends Error {}
}))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => id
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: activate
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

import { useStructuredForkAction } from './use-structured-fork-action'

type Props = Parameters<typeof useStructuredForkAction>[0]
type Controller = Parameters<typeof useStructuredForkAction>[1]

const props = { agent: 'codex', target: { kind: 'local' } } as unknown as Props

/** text -> tool call -> text, the shape of a normal turn. Only the last row is drawn as an
 *  assistant row, so only it can carry the control. */
function turn(): AgentJournalRenderItem[] {
  const bodies: AgentJournalRenderItem['body'][] = [
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Looking' }] },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'read', input: {} }]
    },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answered' }] }
  ]
  return bodies.map((body, index) => ({
    itemId: `codex:parent:a:${index}`,
    revision: 1,
    body,
    sequence: index,
    observedAt: 1
  }))
}

function controller(overrides: { isWorking?: boolean; items?: AgentJournalRenderItem[] } = {}) {
  return {
    forkSupported: true,
    // A distinct parent per test: the command's replay table lives for the module's lifetime.
    forkSource: {
      sessionId: `parent-${Math.random()}`,
      expectedEpoch: 'epoch',
      expectedRuntimeFence: 1
    },
    isWorking: overrides.isWorking ?? false,
    journalItems: overrides.items ?? turn()
  } as unknown as Controller
}

describe('fork action eligibility work', () => {
  it('does no eligibility scan while a turn is live', () => {
    scanned.mockClear()
    const items = turn()
    // A live turn emits a journal delta per frame and the memo runs before the early return, so an
    // ungated memo rescans the whole transcript for a result nothing can use.
    const { result, rerender } = renderHook(() =>
      useStructuredForkAction(props, controller({ isWorking: true, items }), 'worktree', () => {})
    )
    for (let index = 0; index < 5; index += 1) {
      rerender()
    }
    expect(result.current).toBeUndefined()
    expect(scanned).not.toHaveBeenCalled()
  })

  it('offers exactly one action for a multi-row turn, on its last drawn row', () => {
    const { result } = renderHook(() =>
      useStructuredForkAction(props, controller(), 'worktree', () => {})
    )
    expect([...(result.current?.eligibleIds ?? [])]).toEqual(['codex:parent:a:3'])
  })
})

describe('two rows of one turn cannot mint two forks', () => {
  it('joins clicks on sibling rows into a single create for the turn', async () => {
    call.mockReset()
    let finish!: (value: unknown) => void
    call.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const { result } = renderHook(() =>
      useStructuredForkAction(props, controller(), 'worktree', () => {})
    )
    // Two DIFFERENT rows of the same turn. Both resolve to the turn's anchor, so the command's
    // replay table sees one key and the second click joins the first attempt.
    act(() => {
      result.current?.onFork('codex:parent:a:1')
      result.current?.onFork('codex:parent:a:2')
      result.current?.onFork('codex:parent:a:3')
    })
    expect(call).toHaveBeenCalledTimes(1)
    // The create names the anchor, never the clicked row.
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      forkFrom: { itemId: 'codex:parent:a:3' }
    })
    await act(async () => {
      finish({ ok: true, value: { sessionId: 'child-session' } })
    })
  })

  it('offers a way into the child instead of stealing the surface', async () => {
    call.mockReset()
    toastSuccess.mockReset()
    activate.mockReset()
    call.mockResolvedValue({ ok: true, value: { sessionId: 'child-session' } })
    const { result } = renderHook(() =>
      useStructuredForkAction(props, controller(), 'worktree', () => {})
    )
    await act(async () => {
      result.current?.onFork('codex:parent:a:3')
    })
    expect(activate).not.toHaveBeenCalled()
    const options = toastSuccess.mock.calls[0]?.[1] as {
      action: { label: string; onClick: () => void }
    }
    expect(options.action.label).toBe('Open forked chat')
    options.action.onClick()
    expect(activate).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'worktree',
      sessionId: 'child-session'
    })
  })
})
