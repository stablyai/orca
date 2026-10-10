// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './NativeChatMessageRow'

const mocks = vi.hoisted(() => ({ call: vi.fn(), confirm: vi.fn() }))
let state: StructuredAgentSessionState

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./use-structured-agent-session-hold', () => ({
  useStructuredAgentSessionHold: () => undefined
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({ state, loadingOlder: false, loadOlder: vi.fn() })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_REWIND_RECOVERY_CAPABILITY } from '../../../../shared/protocol-version'

const target = { kind: 'local' } as const

describe('rewind target after send acceptance', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_REWIND_RECOVERY_CAPABILITY])
    vi.clearAllMocks()
    localStorage.clear()
    state = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'epoch-1',
      cursor: { epoch: 'epoch-1', sequence: 0 },
      fence: 3,
      status: 'ready'
    }
    mocks.call.mockImplementation((_target, method, params) => {
      if (method === 'agentSession.send') {
        return new Promise(() => {})
      }
      return Promise.resolve(
        method === 'agentSession.rewind'
          ? { ok: true, value: { itemId: params.itemId, epoch: 'epoch-2' } }
          : { models: [], current: {}, rewind: { supported: true } }
      )
    })
  })
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it.each([
    ['codex', 'orca'],
    ['codex', 'provider'],
    ['claude', 'orca'],
    ['claude', 'provider']
  ] as const)('uses the accepted %s row with a %s journal key', async (agent, keySource) => {
    const hook = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session', target, agent, isVisible: true })
    )
    await act(async () => {
      expect(hook.result.current.send('Just sent', [])).toBe(true)
    })
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1))
    const entry = hook.result.current.pending[0]!
    const optimisticId = agentJournalSubmissionKey(entry.clientMessageId)
    const confirm = mocks.confirm.mockResolvedValue(true)
    const row = () => (
      <TooltipProvider>
        <MessageRow
          message={hook.result.current.messages[0]!}
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
          rewind={{
            disabledReason: hook.result.current.rewind.disabledReason,
            request: hook.result.current.rewind.request
          }}
        />
      </TooltipProvider>
    )
    const view = render(row())
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to here' }))
    expect(confirm).not.toHaveBeenCalled()

    const providerItemId = agentJournalItemKey(
      agent === 'codex'
        ? { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }
        : { provider: 'claude', sessionId: 'provider-session', uuid: 'message-uuid' }
    )
    const itemId = keySource === 'orca' ? optimisticId : providerItemId
    state = {
      ...state,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      items: [{ itemId, revision: 1, sequence: 1, observedAt: 1, body: entry.body }],
      submissions: [
        {
          clientMessageId: entry.clientMessageId,
          fence: 3,
          payloadFingerprint: 'send-fingerprint',
          dispatchState: 'accepted',
          providerItemId,
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      ]
    }
    hook.rerender()
    await waitFor(() => expect(hook.result.current.rewind.disabledReason).toBeNull())
    expect(hook.result.current.pending).toEqual([])
    expect(hook.result.current.messages.map((message) => message.id)).toEqual([itemId])
    if (keySource === 'provider') {
      await act(() => hook.result.current.rewind.request(optimisticId, confirm))
      expect(confirm).not.toHaveBeenCalled()
    }

    view.rerender(row())
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to here' }))
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        target,
        'agentSession.rewind',
        expect.objectContaining({ itemId, expectedEpoch: 'epoch-1' })
      )
    )
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rewind to here?' }))
  })
})
