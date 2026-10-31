// @vitest-environment happy-dom

// Exercise card RPCs; hosts without in-place editing must offer no Edit action.

import { toast } from 'sonner'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: rpc }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionWrite
} from './use-structured-agent-session-mutate'

type MutateCall = [string, string, Record<string, unknown>]

function body(text: string): AgentSessionQueuedMessage['body'] {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function draft(id: string, position: number): AgentSessionQueuedMessage {
  return { messageId: id, position, body: body(`text of ${id}`), state: 'waiting' }
}

const SCOPE = 'tab-1:pane-scope'
const write: StructuredAgentSessionWrite = vi.fn(async () => ({ kind: 'dropped' as const }))

function createHarness(
  overrides: {
    queuedMessages?: AgentSessionQueuedMessage[]
    enabled?: boolean
    composerScopeKey?: string | undefined
    mutateResult?: (call: MutateCall) => unknown
    sending?: StructuredAgentSessionPendingSend[]
  } = {}
) {
  const mutateCalls: MutateCall[] = []
  const mutate = vi.fn(async (...call: MutateCall) => {
    mutateCalls.push(call)
    return overrides.mutateResult ? overrides.mutateResult(call) : null
  })
  const mutation = renderHook(() =>
    useStructuredAgentSessionMutate({
      sessionId: 'session',
      target: { kind: 'local' },
      stateRef: { current: { fence: 3 } }
    })
  )
  const rendered = renderHook(() =>
    useStructuredAgentSessionQueuedMessages({
      capturePresentation: mutation.result.current.capturePresentation,
      admit: mutation.result.current.admit,
      enabled: overrides.enabled ?? true,
      queuedMessages: overrides.queuedMessages ?? [draft('draft-1', 1), draft('draft-2', 2)],
      queuePause: null,
      submissions: [],
      hasPendingPrompt: false,
      isWorking: (overrides.sending?.length ?? 0) > 0,
      sending: overrides.sending,
      composerScopeKey: 'composerScopeKey' in overrides ? overrides.composerScopeKey : SCOPE,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each scripted answer is the result shape of the one mutate it responds to; generic erasure cannot express that.
      mutate: mutate as StructuredAgentSessionMutate,
      editTransport: {
        target: { kind: 'local' },
        sessionId: 'session',
        capable: false,
        write: mutation.result.current.write
      }
    })
  )
  return { ...rendered, mutate, mutateCalls, dispose: mutation.unmount }
}

beforeEach(() => {
  clearNativeChatDraftCacheForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('queued message actions', () => {
  const clearOutcomes = [
    'success',
    'current',
    'obsolete',
    'dispatched-current',
    'dispatched-obsolete'
  ]
  it.each(clearOutcomes)('Clear owns ten deletes: %s', async (outcome) => {
    const ids = Array.from({ length: 10 }, (_, index) => `draft-${index + 1}`)
    const release = Promise.withResolvers<void>()
    let active = 0
    let maximum = 0
    rpc.mockImplementation(async (_target, _method, params) => {
      maximum = Math.max(maximum, ++active)
      await release.promise
      active -= 1
      if (outcome === 'success' || params.messageId !== ids[9]) {
        return { ok: true, value: { deleted: true, messageId: params.messageId } }
      }
      return outcome.startsWith('dispatched')
        ? {
            ok: true,
            value: { deleted: false, messageId: params.messageId, disposition: 'dispatched' }
          }
        : {
            ok: false,
            refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
          }
    })
    const harness = createHarness({
      queuedMessages: ids.map((id, index) => draft(id, index + 1))
    })
    let pending: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      pending = harness.result.current.clear()
      expect(await harness.result.current.clear()).toBe(false)
      expect(await harness.result.current.resume()).toBe(false)
    })
    expect(harness.mutateCalls).toEqual([])
    expect(rpc.mock.calls.map(([, , fields]) => fields.messageId)).toEqual(ids.slice(0, 8))
    expect(harness.result.current.queuePending).toBe('clear')
    if (outcome.endsWith('obsolete')) {
      harness.dispose()
    }
    release.resolve()
    await act(async () => expect(await pending).toBe(outcome === 'success'))
    expect(rpc.mock.calls.map(([, , fields]) => fields.messageId)).toEqual(ids)
    expect(maximum).toBe(8)
    for (const [target, , fields] of rpc.mock.calls) {
      expect(target).toEqual({ kind: 'local' })
      expect(fields.envelope).toMatchObject({ sessionId: 'session', expectedRuntimeFence: 3 })
    }
    expect(ids.every((id) => harness.result.current.pending(id) === null)).toBe(true)
    expect(toast.error).toHaveBeenCalledTimes(outcome.endsWith('current') ? 1 : 0)
    if (outcome === 'dispatched-current') {
      expect(toast.error).toHaveBeenCalledWith('This message was already sent.')
    }
    expect(harness.result.current.queuePending).toBeNull()
    expect(harness.result.current.clearCapable).toBe(true)
  })

  it('keeps Clear all unavailable while a local send has no host card', async () => {
    const pending: StructuredAgentSessionPendingSend = {
      clientMessageId: 'pending',
      sessionId: 'session',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'pending' }] },
      previewUris: [],
      queuedAt: 1,
      delivery: 'queue-if-active',
      phase: 'sending',
      issued: true
    }
    const harness = createHarness({ sending: [pending] })
    expect(harness.result.current.cards.map((card) => card.messageId)).toContain('pending')
    expect(harness.result.current.clearCapable).toBe(false)
    await act(async () => expect(await harness.result.current.clear()).toBe(false))
    expect(harness.mutate).not.toHaveBeenCalled()
  })

  it('Steer sends the named draft through queuedMessageSend', async () => {
    const harness = createHarness()
    await act(() => harness.result.current.steer('draft-1'))
    expect(harness.mutate).toHaveBeenCalledWith(
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessageSend',
      { messageId: 'draft-1' }
    )
  })

  it('Cmd/Ctrl+Shift+Enter steers the head card and reports when there is none', async () => {
    const harness = createHarness()
    expect(harness.result.current.steerHead()).toBe(true)
    await waitFor(() =>
      expect(harness.mutate).toHaveBeenCalledWith(
        'agentSession.queuedMessageSend',
        'agentSession.queuedMessageSend',
        { messageId: 'draft-1' }
      )
    )
    const empty = createHarness({ queuedMessages: [] })
    expect(empty.result.current.steerHead()).toBe(false)
    const disabled = createHarness({ enabled: false })
    expect(disabled.result.current.steerHead()).toBe(false)
  })

  it.each(['current', 'obsolete'])('Delete already sent: %s', async (presentation) => {
    const answer = Promise.withResolvers<AgentSessionQueuedMessageDeleteResult>()
    const harness = createHarness({ mutateResult: () => answer.promise })
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = harness.result.current.remove('draft-1')
    })
    expect(harness.result.current.pending('draft-1')).toBe('delete')
    expect(harness.result.current.clearCapable).toBe(false)
    expect(harness.mutate).toHaveBeenCalledWith(
      'agentSession.queuedMessageDelete',
      'agentSession.queuedMessageDelete',
      { messageId: 'draft-1' }
    )
    if (presentation === 'obsolete') {
      harness.dispose()
    }
    await act(async () => {
      answer.resolve({ deleted: false, messageId: 'draft-1', disposition: 'dispatched' })
      await pending
    })
    expect(vi.mocked(toast.error).mock.calls).toEqual(
      presentation === 'current' ? [['This message was already sent.']] : []
    )
    expect(harness.result.current.pending('draft-1')).toBeNull()
    expect(harness.result.current.clearCapable).toBe(true)
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('a host that cannot edit in place offers no Edit and never copies or deletes', async () => {
    const harness = createHarness()
    await act(() => harness.result.current.edit('draft-1'))
    expect(harness.result.current.editCapable).toBe(false)
    expect(harness.result.current.editor).toBeUndefined()
    expect(harness.mutate).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('a second press on a card while its action is in flight sends nothing more', async () => {
    const harness = createHarness()
    await act(async () => {
      await Promise.all([
        harness.result.current.steer('draft-1'),
        harness.result.current.steer('draft-1')
      ])
    })
    expect(harness.mutate).toHaveBeenCalledTimes(1)
  })
})
