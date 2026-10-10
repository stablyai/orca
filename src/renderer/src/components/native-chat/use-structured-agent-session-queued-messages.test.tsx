// @vitest-environment happy-dom

// The queued-message controller: which RPC each card action issues, and that a host which cannot
// edit in place gets no Edit at all, never the old copy-and-delete.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
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
  } = {}
) {
  const mutateCalls: MutateCall[] = []
  const mutate = vi.fn(async (...call: MutateCall) => {
    mutateCalls.push(call)
    return overrides.mutateResult ? overrides.mutateResult(call) : null
  })
  const rendered = renderHook(() =>
    useStructuredAgentSessionQueuedMessages({
      enabled: overrides.enabled ?? true,
      queuedMessages: overrides.queuedMessages ?? [draft('draft-1', 1), draft('draft-2', 2)],
      queuePause: null,
      submissions: [],
      hasPendingPrompt: false,
      isWorking: false,
      composerScopeKey: 'composerScopeKey' in overrides ? overrides.composerScopeKey : SCOPE,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each scripted answer is the result shape of the one mutate it responds to; generic erasure cannot express that.
      mutate: mutate as StructuredAgentSessionMutate,
      editTransport: { target: { kind: 'local' }, sessionId: 'session', capable: false, write }
    })
  )
  return { ...rendered, mutate, mutateCalls }
}

beforeEach(() => {
  clearNativeChatDraftCacheForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('queued message actions', () => {
  it('Steer sends the named draft through queuedMessageSend', async () => {
    const harness = createHarness()
    await act(() => harness.result.current.steer('draft-1'))
    expect(harness.mutate).toHaveBeenCalledWith(
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessageSend',
      { messageId: 'draft-1' }
    )
  })

  it('Cmd/Ctrl+Enter steers the newest card and reports when there is none', async () => {
    const harness = createHarness()
    expect(harness.result.current.steerNewest()).toBe(true)
    await waitFor(() =>
      expect(harness.mutate).toHaveBeenCalledWith(
        'agentSession.queuedMessageSend',
        'agentSession.queuedMessageSend',
        { messageId: 'draft-2' }
      )
    )
    const empty = createHarness({ queuedMessages: [] })
    expect(empty.result.current.steerNewest()).toBe(false)
    const disabled = createHarness({ enabled: false })
    expect(disabled.result.current.steerNewest()).toBe(false)
  })

  it('Delete withdraws through queuedMessageDelete without touching the composer', async () => {
    const harness = createHarness()
    await act(() => harness.result.current.remove('draft-1'))
    expect(harness.mutate).toHaveBeenCalledWith(
      'agentSession.queuedMessageDelete',
      'agentSession.queuedMessageDelete',
      { messageId: 'draft-1' }
    )
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
