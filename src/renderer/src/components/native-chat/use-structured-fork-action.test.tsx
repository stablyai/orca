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
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => options?.[name] ?? '')
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

import { useStructuredForkAction } from './use-structured-fork-action'

type Props = Parameters<typeof useStructuredForkAction>[0]
type Controller = Parameters<typeof useStructuredForkAction>[1]

const props = { agent: 'codex', target: { kind: 'local' } } as unknown as Props

/** text -> tool call -> text, the shape of a normal turn. Tool activity is a `tool-call` BODY,
 *  which is what the live translators emit; only the last row draws a control cluster. */
function turn(): AgentJournalRenderItem[] {
  const bodies: AgentJournalRenderItem['body'][] = [
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Looking' }] },
    { kind: 'tool-call', name: 'read', input: {}, state: 'completed' },
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

/** The settled turn above, followed by a prompt whose turn is still running. */
function turnThenLiveTurn(): AgentJournalRenderItem[] {
  return [
    ...turn(),
    {
      itemId: 'codex:parent:b:0',
      revision: 1,
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Next' }]
      },
      sequence: 4,
      observedAt: 1
    },
    {
      itemId: 'legacy:codex:parent:turn-lifecycle%3Ab',
      revision: 1,
      body: {
        kind: 'status' as const,
        text: 'Working',
        turnLifecycle: { turnId: 'b', state: 'running' as const }
      },
      sequence: 5,
      observedAt: 1
    }
  ]
}

function controller(
  overrides: {
    isWorking?: boolean
    items?: AgentJournalRenderItem[]
    forkSupported?: boolean
  } = {}
) {
  return {
    forkSupported: overrides.forkSupported ?? true,
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
  it('still offers SETTLED turns while another turn is streaming', () => {
    // The host is per-turn: `selectAgentSessionPrefix(boundary:'through')` serves a settled turn and
    // refuses only the live one as `busy`. Gating the hook on session-level `isWorking` stripped the
    // action off EVERY turn the moment anything streamed — the case where branching is most useful.
    const { result } = renderHook(() =>
      useStructuredForkAction(
        props,
        controller({ isWorking: true, items: turnThenLiveTurn() }),
        'worktree',
        () => {}
      )
    )
    expect([...(result.current?.eligibleIds ?? [])]).toEqual(['codex:parent:a:3'])
  })

  it('withholds the LIVE turn even so', () => {
    const { result } = renderHook(() =>
      useStructuredForkAction(
        props,
        controller({ isWorking: true, items: turnThenLiveTurn() }),
        'worktree',
        () => {}
      )
    )
    expect(result.current?.eligibleIds.has('codex:parent:b:0')).toBe(false)
  })

  it('keeps its click handler stable across journal deltas so anchor rows do not re-render', () => {
    // A live turn republishes the journal every frame. A handler rebuilt per frame would hand every
    // anchor row a new prop and defeat the row memo the transcript depends on. Everything except the
    // journal is held fixed, so only the per-frame republish is under test.
    const stable = controller({ isWorking: true })
    const onError = () => {}
    let items = turnThenLiveTurn()
    const { result, rerender } = renderHook(() =>
      useStructuredForkAction(props, { ...stable, journalItems: items }, 'worktree', onError)
    )
    const first = result.current?.onFork
    for (let index = 0; index < 5; index += 1) {
      items = [...items]
      rerender()
    }
    expect(result.current?.onFork).toBe(first)
    // Still resolves against the newest journal, not the one the handler closed over.
    expect(result.current?.eligibleIds.has('codex:parent:a:3')).toBe(true)
  })

  it('does no eligibility scan when forking is unavailable', () => {
    scanned.mockClear()
    const { result, rerender } = renderHook(() =>
      useStructuredForkAction(props, controller({ forkSupported: false }), 'worktree', () => {})
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

  it('reports the host reason for a refusal that carries no fork reason', async () => {
    // Rendered QA hit exactly this and could not debug it: a refusal raised past the fork's own
    // vocabulary — a provider that never finished starting, a stale checkpoint — has no
    // `forkReason`, and every one of them reached the user as "could not be confirmed".
    call.mockReset()
    const errors: string[] = []
    call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: 'Claude did not finish starting session child within 10 seconds.'
      }
    })
    const { result } = renderHook(() =>
      useStructuredForkAction(props, controller(), 'worktree', (message) => errors.push(message))
    )
    await act(async () => {
      result.current?.onFork('codex:parent:a:3')
    })
    expect(errors).toEqual([
      'Could not fork this turn: Claude did not finish starting session child within 10 seconds.'
    ])
  })

  it('still says UNCONFIRMED when the host could not adjudicate the child', async () => {
    call.mockReset()
    const errors: string[] = []
    call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: 'agent_session_fork:outcome-unknown',
        forkReason: 'outcome-unknown'
      }
    })
    const { result } = renderHook(() =>
      useStructuredForkAction(props, controller(), 'worktree', (message) => errors.push(message))
    )
    await act(async () => {
      result.current?.onFork('codex:parent:a:3')
    })
    expect(errors).toEqual([
      'A fork could not be confirmed. Retry the same turn to check its outcome.'
    ])
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
