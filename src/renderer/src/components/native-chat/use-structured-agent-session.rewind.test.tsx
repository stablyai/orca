// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { AGENT_SESSION_REWIND_RECOVERY_CAPABILITY as RECOVERY } from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  operationId: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  outboxSend: vi.fn(),
  remoteCapabilities: new Set<string>()
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: async (_environmentId: string, capability: string) =>
    mocks.remoteCapabilities.has(capability)
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: mocks.toastMessage } }))
let fence = 3
let epoch = 'epoch-1'
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []
let queuedMessages: AgentSessionQueuedMessage[] | null = null

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      epoch,
      cursor: { epoch, sequence: 2 },
      items,
      submissions,
      queuedMessages,
      status: 'ready',
      error: null,
      hasOlder: false
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: mocks.operationId
}))
vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: mocks.outboxSend,
    stopSends: vi.fn()
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-queued-message-wire'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  nativeChatRewindReasonCopy,
  nativeChatRewindReturnedUnknownCopy
} from './native-chat-rewind-copy'

const LOCAL_TARGET = { kind: 'local' } as const

// This build's host settles an in-doubt rewind on the next send; an older one is tested below.
beforeEach(() => {
  setLocalRuntimeCapabilitiesForTests([RECOVERY])
  mocks.remoteCapabilities = new Set([RECOVERY])
})
afterEach(() => setLocalRuntimeCapabilitiesForTests(null))

const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [{ value: 'medium', label: 'Medium' }]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

describe('useStructuredAgentSession rewind RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    epoch = 'epoch-1'
    submissions = []
    queuedMessages = null
    items = [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Prompt' }] }
      }
    ]
    mocks.operationId.mockReset().mockReturnValue('rewind-operation')
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(
        method === 'agentSession.options'
          ? { ...OPTIONS, rewind: { supported: true } }
          : { ok: true, value: { itemId: 'user-1', epoch: 'epoch-2' } }
      )
    )
  })

  it('sends the agreed verb and fingerprint to the execution host and holds sends until reset', async () => {
    const target = { kind: 'environment' as const, environmentId: 'ssh-host' }
    const view = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    const { structuredAgentSessionPayloadFingerprint } =
      await import('../../../../shared/structured-agent-session-mutation')
    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.rewind', {
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'rewind-operation',
        expectedRuntimeFence: 3,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.rewind',
          sessionId: 'session-1',
          fields: { itemId: 'user-1', expectedEpoch: 'epoch-1' }
        })
      },
      itemId: 'user-1',
      expectedEpoch: 'epoch-1'
    })
    expect(view.result.current.send('stale composer text', [])).toBe(false)
    expect(mocks.toastMessage).toHaveBeenCalledWith(
      'Wait for the conversation to go back to the earlier message.'
    )
    epoch = 'epoch-2'
    items = []
    view.rerender()
    expect(view.result.current.messages).toEqual([])
    expect(view.result.current.rewind.pending).toBe(false)
  })

  it('renders reason-only host refusals without relying on host English', async () => {
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(
        method === 'agentSession.options'
          ? { ...OPTIONS, rewind: { supported: true } }
          : {
              ok: false,
              refusal: {
                code: 'agent_session_operation_invalid',
                message: '',
                details: { reason: 'rewindRefused', rewindReason: 'proof-mismatch' }
              }
            }
      )
    )
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'claude',
        isVisible: true
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      nativeChatRewindReasonCopy('proof-mismatch')
    )
    expect(view.result.current.error).toBeNull()
  })

  it('explains an older host missing the RPC without claiming an uncertain rewind occurred', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.rewind'
        ? Promise.reject(
            new RuntimeRpcCallError({
              id: '1',
              ok: false,
              error: { code: 'method_not_found', message: 'Unknown method' },
              _meta: { runtimeId: 'runtime' }
            })
          )
        : Promise.resolve({ ...OPTIONS, rewind: { supported: true } })
    )
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      nativeChatRewindReasonCopy('unsupported')
    )
    expect(view.result.current.rewind.pending).toBe(false)
  })

  it('an unknown outcome leaves sending open and returns the message to the composer', async () => {
    // A remote host without the capability throws before anything is sent: the outcome reads unknown.
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.rewind'
        ? Promise.reject(new Error('Rewinding requires a newer Orca server.'))
        : Promise.resolve({ ...OPTIONS, rewind: { supported: true } })
    )
    const onMessageReturned = vi.fn()
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        composerScopeKey: 'unknown-scope',
        rewind: { onMessageReturned }
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(readNativeChatDraftCache('unknown-scope')).toContain('Prompt')
    expect(onMessageReturned).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(nativeChatRewindReturnedUnknownCopy())
    expect(view.result.current.error).toBeNull()
    view.result.current.send('Prompt', [])
    expect(mocks.outboxSend).toHaveBeenCalledOnce()
  })

  it("lets the host's in-doubt latch disable only the action", async () => {
    mocks.call.mockResolvedValue({ ...OPTIONS, rewind: { supported: true } })
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        rewind: { hostBlockedReason: 'outcome-unknown' }
      })
    )
    await waitFor(() => expect(view.result.current.rewind.surface).toBeDefined())
    expect(view.result.current.rewind.surface?.disabledReason).toBe(
      nativeChatRewindReasonCopy('outcome-unknown')
    )
    view.result.current.send('Next prompt', [])
    expect(mocks.outboxSend).toHaveBeenCalledOnce()
    expect(view.result.current.error).toBeNull()
  })

  it("holds the action behind the host's queued cards", async () => {
    mocks.call.mockResolvedValue({ ...OPTIONS, rewind: { supported: true } })
    queuedMessages = [
      {
        messageId: 'queued-1',
        position: 0,
        state: 'waiting',
        paused: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Held' }] }
      }
    ]
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(view.result.current.rewind.surface).toBeDefined())
    expect(view.result.current.rewind.disabledReason).toBe(nativeChatRewindReasonCopy('busy'))
  })
})

describe('useStructuredAgentSession rewind support and composer return', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    epoch = 'epoch-1'
    submissions = []
    queuedMessages = null
    items = [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix the bug' }] }
      }
    ]
    mocks.operationId.mockReset().mockReturnValue('rewind-operation')
  })

  it('offers no action on a host whose options name no rewind', async () => {
    mocks.call.mockResolvedValue(OPTIONS)
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() =>
      expect(view.result.current.rewind.disabledReason).toBe(
        nativeChatRewindReasonCopy('unsupported')
      )
    )
    expect(view.result.current.rewind.surface).toBeUndefined()
  })

  it('returns the discarded message to the composer after the existing draft', async () => {
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(
        method === 'agentSession.options'
          ? { ...OPTIONS, rewind: { supported: true } }
          : { ok: true, value: { itemId: 'user-1', epoch: 'epoch-2' } }
      )
    )
    writeNativeChatDraftCache('rewind-scope', 'Half-typed')
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        composerScopeKey: 'rewind-scope'
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(readNativeChatDraftCache('rewind-scope')).toContain('Half-typed')
    expect(readNativeChatDraftCache('rewind-scope')).toContain('Fix the bug')
  })
})

describe('offering rewind only where the next send settles an in-doubt one', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    epoch = 'epoch-1'
    submissions = []
    queuedMessages = null
    items = [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Prompt' }] }
      }
    ]
    mocks.call.mockResolvedValue({ ...OPTIONS, rewind: { supported: true } })
  })

  const remote = { kind: 'environment' as const, environmentId: 'ssh-host' }
  const render = (target: typeof remote | typeof LOCAL_TARGET) =>
    renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )

  it('offers it on a remote host that advertises the recovery', async () => {
    const view = render(remote)
    await waitFor(() => expect(view.result.current.rewind.surface).toBeDefined())
  })

  it('offers none on a remote host that rewinds but predates the recovery', async () => {
    mocks.remoteCapabilities = new Set()
    const view = render(remote)
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(remote, 'agentSession.options', expect.anything())
    )
    await act(async () => {})
    expect(view.result.current.rewind.surface).toBeUndefined()
  })

  it('offers it locally once the runtime answers, and none while it has not', async () => {
    expect(render(LOCAL_TARGET).result.current.rewind.surface).toBeUndefined()
    const view = render(LOCAL_TARGET)
    await waitFor(() => expect(view.result.current.rewind.surface).toBeDefined())
    setLocalRuntimeCapabilitiesForTests(null)
    const unanswered = render(LOCAL_TARGET)
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    await act(async () => {})
    expect(unanswered.result.current.rewind.surface).toBeUndefined()
  })
})
