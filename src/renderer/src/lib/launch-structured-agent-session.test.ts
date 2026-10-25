import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useAppStore } from '@/store'
import {
  createStructuredAgentSessionLaunchIntent,
  launchStructuredAgentSession,
  restoreStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError,
  StructuredAgentSessionOwnerUnresolvedError
} from './launch-structured-agent-session'
import { admitStructuredLaunchOnHost } from './structured-agent-session-host-admission'
import {
  clearWebSessionFocusIntent,
  peekWebSessionFocusIntent
} from '@/runtime/web-session-focus-intent'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))
const hostPermission = vi.hoisted(() =>
  vi.fn<() => Promise<{ kind: string; hostMode?: null }>>(async () => ({ kind: 'allowed' }))
)
vi.mock('@/runtime/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: hostPermission
}))

describe('structured agent session launch', () => {
  beforeEach(() => {
    vi.mocked(callStructuredAgentSession).mockReset()
  })

  it('only a fresh foreground launch grants publication permission to select its chat', () => {
    const worktreeId = 'focus-lifecycle'
    const owner = { environmentId: 'server-1' }
    const intent = createStructuredAgentSessionLaunchIntent(worktreeId, 'codex', 'runtime:server-1')
    expect(peekWebSessionFocusIntent(owner, worktreeId)?.hostTabId).toBe(
      `agent-session:${intent.sessionId}`
    )
    clearWebSessionFocusIntent(owner, worktreeId)
    retryStructuredAgentSessionLaunchIntent(intent)
    restoreStructuredAgentSessionLaunchIntent({
      worktreeId,
      executionHostId: intent.executionHostId,
      agent: intent.agent,
      ...intent.params.envelope
    })
    createStructuredAgentSessionLaunchIntent(
      worktreeId,
      'codex',
      'runtime:server-1',
      undefined,
      undefined,
      false
    )
    expect(peekWebSessionFocusIntent(owner, worktreeId)).toBeNull()
  })

  // The chat opens before its host answers, so the create is the last thing that can say no.
  it('issues no create to a host held for its access, or after its chat closed', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({ supported: true })
    const held = createStructuredAgentSessionLaunchIntent(
      'workspace-1',
      'claude',
      'runtime:server-1'
    )
    hostPermission.mockResolvedValueOnce({ kind: 'refused', hostMode: null })
    await expect(launchStructuredAgentSession(held)).rejects.toMatchObject({
      code: 'structured_agent_session_host_permission'
    })
    const closed = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
    await expect(
      launchStructuredAgentSession(closed, undefined, false, () => true)
    ).rejects.toThrow('retired before create')
    expect(
      vi
        .mocked(callStructuredAgentSession)
        .mock.calls.some(([, method]) => method === 'agentSession.create')
    ).toBe(false)
  })

  it('creates a native session with a host-verifiable launch intent', async () => {
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method, params) =>
      method === 'agentSession.createSupport'
        ? { supported: true }
        : {
            ok: true,
            replayed: false,
            fence: 1,
            cursor: { epoch: 'epoch-1', sequence: 0 },
            value: {
              sessionId: (params as { envelope: { sessionId: string } }).envelope.sessionId,
              fence: 1,
              page: {
                sessionId: 'session-1',
                epoch: 'epoch-1',
                direction: 'tail',
                items: [],
                removedItemIds: [],
                submissions: [],
                window: {
                  oldest: null,
                  newest: null,
                  nextCursor: { epoch: 'epoch-1', sequence: 0 }
                },
                liveCursor: { epoch: 'epoch-1', sequence: 0 },
                hasOlder: false,
                hasNewer: false
              },
              unconfirmedClientMessageIds: []
            }
          }
    )

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'codex')
    const receipt = await launchStructuredAgentSession(intent)
    const params = vi
      .mocked(callStructuredAgentSession)
      .mock.calls.find(([, method]) => method === 'agentSession.create')?.[2] as {
      envelope: { sessionId: string; payloadFingerprint: string }
      worktree: string
      agent: 'codex'
    }

    expect(receipt).toEqual({
      sessionId: expect.stringMatching(/^codex_[A-Za-z0-9_]{36}$/),
      fence: 1
    })
    expect(callStructuredAgentSession).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.create',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' })
    )
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: params.envelope.sessionId,
        fields: { worktree: 'id:workspace-1', agent: 'codex' }
      })
    )
    expect(params).toBe(intent.params)
  })

  it('creates the session on the paired server that owns the workspace', async () => {
    const initial = useAppStore.getState()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the catalog fields owner resolution reads are staged.
    useAppStore.setState({
      repos: [{ id: 'repo-remote', connectionId: null, executionHostId: 'runtime:server-1' }],
      worktreesByRepo: {
        'repo-remote': [
          { id: 'remote-workspace', repoId: 'repo-remote', hostId: 'runtime:server-1' }
        ]
      }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    try {
      vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
        method === 'agentSession.createSupport'
          ? { supported: true }
          : { ok: true, replayed: false, value: { sessionId: 'claude_1', fence: 1 } }
      )

      const intent = createStructuredAgentSessionLaunchIntent('remote-workspace', 'claude')
      await launchStructuredAgentSession(intent)

      const server = { kind: 'environment', environmentId: 'server-1' }
      expect(intent.target).toEqual(server)
      expect(
        vi.mocked(callStructuredAgentSession).mock.calls.map(([target, method]) => [target, method])
      ).toEqual([
        [server, 'agentSession.createSupport'],
        [server, 'agentSession.create']
      ])
    } finally {
      useAppStore.setState({ repos: initial.repos, worktreesByRepo: initial.worktreesByRepo })
    }
  })

  describe('the host a chat is launched on', () => {
    const SERVER = { kind: 'environment', environmentId: 'server-1' }
    const initial = useAppStore.getState()
    // `repoId::path` names a checkout on this machine and one on the paired server.
    const stageCollidingWorkspace = (): void =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the catalog fields owner resolution reads are staged.
      useAppStore.setState({
        activeWorktreeId: 'another-workspace',
        worktreesByRepo: {
          'repo-1': [
            { id: 'repo-1::/work/app', repoId: 'repo-1', hostId: 'local' },
            { id: 'repo-1::/work/app', repoId: 'repo-1', hostId: 'runtime:server-1' }
          ]
        }
      } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    const restoreStore = (): void =>
      useAppStore.setState({
        activeWorktreeId: initial.activeWorktreeId,
        worktreesByRepo: initial.worktreesByRepo
      })

    it('is the one the route chose, kept through a retry', () => {
      stageCollidingWorkspace()
      try {
        const intent = createStructuredAgentSessionLaunchIntent(
          'repo-1::/work/app',
          'claude',
          'runtime:server-1'
        )
        expect(intent.target).toEqual(SERVER)
        expect(retryStructuredAgentSessionLaunchIntent(intent).target).toEqual(SERVER)
      } finally {
        restoreStore()
      }
    })

    it('is refused rather than guessed when two hosts publish the workspace', () => {
      stageCollidingWorkspace()
      try {
        expect(() =>
          createStructuredAgentSessionLaunchIntent('repo-1::/work/app', 'claude')
        ).toThrow(StructuredAgentSessionOwnerUnresolvedError)
      } finally {
        restoreStore()
      }
    })

    it('comes back from the persisted launch after a reload', () => {
      const intent = restoreStructuredAgentSessionLaunchIntent({
        worktreeId: 'workspace-1',
        executionHostId: 'runtime:server-1',
        sessionId: 'claude_1',
        agent: 'claude',
        clientOperationId: 'op-1',
        payloadFingerprint: 'fp-1',
        expectedRuntimeFence: null
      })
      expect(intent.target).toEqual(SERVER)
    })
  })

  // The picker's stand-in must be what the chat runs: only this machine's own chats run its picks.
  it("seeds only a local chat with this machine's saved selection", () => {
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      settings: { ...settings!, nativeChatSessionOptions: { codex: { model: 'gpt-5.5' } } }
    })
    try {
      expect(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'codex', 'local').seedOptions
      ).toEqual({ model: 'gpt-5.5', permissionMode: 'ask' })
      expect(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'codex', 'runtime:server-1')
          .seedOptions
      ).toBeUndefined()
    } finally {
      useAppStore.setState({ settings })
    }
  })

  it('names Claude as the create provider and in the session id', () => {
    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
    expect(intent.sessionId).toMatch(/^claude_[A-Za-z0-9_]{36}$/)
    expect(intent.params.agent).toBe('claude')
    expect(intent.params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: intent.sessionId,
        fields: { worktree: 'id:workspace-1', agent: 'claude' }
      })
    )
  })

  it.each(['claude', 'codex'] as const)(
    'asks the executing host for create support before creating a %s session',
    async (agent) => {
      vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
        method === 'agentSession.createSupport'
          ? { supported: true }
          : { ok: true, replayed: false, value: { sessionId: `${agent}_1`, fence: 1 } }
      )

      const intent = createStructuredAgentSessionLaunchIntent('workspace-1', agent)
      await launchStructuredAgentSession(intent)

      expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.createSupport',
        'agentSession.create'
      ])
      expect(callStructuredAgentSession).toHaveBeenNthCalledWith(
        1,
        { kind: 'local' },
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent }
      )
    }
  )

  it.each(['claude', 'codex'] as const)(
    'refuses a %s launch the host says it cannot support, without creating',
    async (agent) => {
      vi.mocked(callStructuredAgentSession).mockResolvedValue({ supported: false, reason: 'agent' })

      const intent = createStructuredAgentSessionLaunchIntent('workspace-1', agent)

      await expect(launchStructuredAgentSession(intent)).rejects.toBeInstanceOf(
        StructuredAgentSessionCreateRefusalError
      )
      expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.createSupport'
      ])
    }
  )

  // A retry may follow a create whose reply was lost, so an unanswered probe stays reconcilable.
  it('keeps an unanswered create support probe recoverable', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('runtime unreachable'))

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')

    await expect(launchStructuredAgentSession(intent)).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateUnknownOutcomeError
    )
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()
  })

  it('answers admission with the host verdict, before anything is created', async () => {
    const server = { kind: 'environment' as const, environmentId: 'server-1' }
    vi.mocked(callStructuredAgentSession).mockResolvedValueOnce({ supported: true })
    await expect(admitStructuredLaunchOnHost(server, 'id:wt-1', 'claude')).resolves.toEqual({
      kind: 'admitted'
    })
    vi.mocked(callStructuredAgentSession).mockResolvedValueOnce({ supported: false, reason: 'wsl' })
    // The reason names what to tell the user (for example, no chat in WSL).
    await expect(admitStructuredLaunchOnHost(server, 'id:wt-1', 'claude')).resolves.toEqual({
      kind: 'declined',
      reason: 'wsl'
    })
    vi.mocked(callStructuredAgentSession).mockRejectedValueOnce(new Error('runtime unreachable'))
    await expect(admitStructuredLaunchOnHost(server, 'id:wt-1', 'claude')).resolves.toEqual({
      kind: 'unreachable'
    })
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport'
    ])
  })

  // The server's own saved selection is what create seeds, so it is what the picker shows.
  it('carries the seed an admitting server reports, keeping only seedable values', async () => {
    const server = { kind: 'environment' as const, environmentId: 'server-1' }
    vi.mocked(callStructuredAgentSession).mockResolvedValueOnce({
      supported: true,
      seedOptions: { model: 'opus', fastMode: 'true', personality: 'terse', effort: 7 }
    })

    await expect(admitStructuredLaunchOnHost(server, 'id:wt-1', 'claude')).resolves.toEqual({
      kind: 'admitted',
      seedOptions: { model: 'opus', fastMode: 'true' }
    })
  })

  it("restores a paired launch with the server's seed it kept, never this machine's", () => {
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      settings: { ...settings!, nativeChatSessionOptions: { claude: { model: 'sonnet' } } }
    })
    const restore = (executionHostId: 'local' | 'runtime:server-1') =>
      restoreStructuredAgentSessionLaunchIntent({
        worktreeId: 'workspace-1',
        executionHostId,
        sessionId: 'claude_1',
        agent: 'claude',
        clientOperationId: 'operation-1',
        payloadFingerprint: 'fingerprint-1',
        expectedRuntimeFence: null,
        seedOptions: { model: 'opus' }
      })
    try {
      expect(restore('runtime:server-1').seedOptions).toEqual({ model: 'opus' })
      expect(restore('local').seedOptions).toEqual({ model: 'sonnet', permissionMode: 'ask' })
    } finally {
      useAppStore.setState({ settings })
    }
  })

  it("reports a paired server's current seed from the create probe, and no local one", async () => {
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
      method === 'agentSession.createSupport'
        ? { supported: true, seedOptions: { model: 'sonnet' } }
        : { ok: true, replayed: false, value: { sessionId: 'claude_1', fence: 1 } }
    )
    const paired = vi.fn()
    const local = vi.fn()

    await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-1', 'claude', 'runtime:server-1'),
      paired
    )
    await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-1', 'claude', 'local'),
      local
    )

    expect(paired).toHaveBeenCalledWith({ model: 'sonnet' })
    expect(local).not.toHaveBeenCalled()
  })

  it("seeds a paired chat with the server's reported selection, kept through a retry", () => {
    const intent = createStructuredAgentSessionLaunchIntent(
      'workspace-1',
      'claude',
      'runtime:server-1',
      undefined,
      { model: 'opus' }
    )

    expect(intent.seedOptions).toEqual({ model: 'opus' })
    expect(retryStructuredAgentSessionLaunchIntent(intent).seedOptions).toEqual({ model: 'opus' })
  })

  /** A worktree is not resolvable for a beat after createWorktree resolves, so the probe fails with
   *  selector_not_found instead of answering. That is "not ready", not "no". */
  it('retries a probe the host cannot answer yet, then creates', async () => {
    const notResolvableYet = Object.assign(new Error('selector_not_found'), {
      code: 'selector_not_found'
    })
    vi.mocked(callStructuredAgentSession)
      .mockRejectedValueOnce(notResolvableYet)
      .mockRejectedValueOnce(notResolvableYet)
      .mockImplementation(async (_target, method) =>
        method === 'agentSession.createSupport'
          ? { supported: true }
          : { ok: true, replayed: false, value: { sessionId: 'claude_1', fence: 1 } }
      )

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
    await expect(launchStructuredAgentSession(intent)).resolves.toMatchObject({
      sessionId: 'claude_1'
    })
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.create'
    ])
  })

  it('refuses once the retry budget for an unresolvable selector is spent', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValue(
      Object.assign(new Error('selector_not_found'), { code: 'selector_not_found' })
    )

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')

    await expect(launchStructuredAgentSession(intent)).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    // Bounded: the first ask plus the retry delays, and never agentSession.create.
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport'
    ])
  })

  it('does not retry a host that answered no, or an unrelated failure', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({ supported: false, reason: 'wsl' })
    await expect(
      launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
      )
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()

    vi.mocked(callStructuredAgentSession).mockReset()
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('runtime unreachable'))
    await expect(
      launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
      )
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()
  })

  /** A message-wrapped token must not be confused with prose that merely mentions it. */
  it('does not retry a failure that only mentions the token in passing', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValue(
      new Error('Access denied after a prior selector_not_found')
    )

    await expect(
      launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
      )
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()
  })

  /** The probe now runs for Codex too, so create-outcome tests script it to say yes. */
  function mockSupportedCreate(create: () => unknown): void {
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
      method === 'agentSession.createSupport' ? { supported: true } : create()
    )
  }

  it('replays the exact create envelope when an unknown outcome is retried', async () => {
    const intent = createStructuredAgentSessionLaunchIntent('workspace-retry', 'codex')
    mockSupportedCreate(() => {
      throw new Error('response lost')
    })

    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('response lost')
    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('response lost')

    const createCalls = vi
      .mocked(callStructuredAgentSession)
      .mock.calls.filter(([, method]) => method === 'agentSession.create')
    const first = createCalls[0]?.[2]
    const second = createCalls[1]?.[2]
    expect(first).toBe(intent.params)
    expect(second).toBe(first)
    expect(intent.params.envelope.clientOperationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
  })

  it('preserves an unknown refusal code without classifying it as fallback-safe', async () => {
    mockSupportedCreate(() => ({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may already exist.'
      }
    }))

    const error = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-unknown', 'codex')
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
    expect(error).not.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(error).toMatchObject({ code: 'agent_session_operation_unknown' })
  })

  /** The class is the verdict, so a refusal message that happens to end in a definitive token
   *  must not be re-read into one by the transport-error matcher. */
  it('keeps an unknown outcome unknown even when its message ends in a definitive token', async () => {
    mockSupportedCreate(() => ({
      ok: false,
      refusal: {
        code: 'agent_session_ownership_unknown',
        message: 'Owner check failed: method_not_found'
      }
    }))

    const error = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-unknown-token', 'codex')
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
  })

  it.each(['method_not_found', 'structured_agent_session_unsupported'])(
    'turns an old-host %s error into a definitive transport refusal',
    async (code) => {
      mockSupportedCreate(() => {
        throw Object.assign(new Error(code), { code })
      })
      const oldHostError = await launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent(`workspace-old-host-${code}`, 'codex')
      ).catch((caught: unknown) => caught)

      expect(oldHostError).toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
      expect(oldHostError).toMatchObject({ code })
    }
  )

  it('keeps an unclassified transport failure outcome unknown', async () => {
    mockSupportedCreate(() => {
      throw Object.assign(new Error('Connection lost'), { code: 'runtime_error' })
    })
    const transportError = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-offline', 'codex')
    ).catch((caught: unknown) => caught)

    expect(transportError).not.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
  })

  // Pins the thrown-error half (round-2 S5): a host that flattened the refusal to runtime_error
  // still ends it with the token, and client-minted codes never prove nothing was created.
  it('reads a definitive token from a flattened runtime_error message', async () => {
    mockSupportedCreate(() => {
      throw Object.assign(new Error('structured_agent_session_unsupported'), {
        code: 'runtime_error'
      })
    })
    const error = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-flattened-refusal', 'codex')
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(error).toMatchObject({ code: 'structured_agent_session_unsupported' })
  })

  it.each([
    'runtime_manually_disconnected',
    'runtime_rpc_queue_overloaded',
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'method_not_supported'
  ])('keeps a thrown %s outcome unknown', async (code) => {
    mockSupportedCreate(() => {
      throw Object.assign(new Error('failed'), { code })
    })
    const error = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent(`workspace-client-${code}`, 'codex')
    ).catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
  })
})
