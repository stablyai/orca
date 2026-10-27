import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

type BeginArgs = { beforeOpen?: (sessionId: string) => boolean | void }
type Launch = {
  sessionId: string
  settlement: Promise<StructuredAgentLaunchSettlement>
  tab: { id: string }
}

const mocks = vi.hoisted(() => {
  const state: { owner: ExecutionHostId | null } = { owner: 'local' }
  return {
    beginStructuredAgentSessionProvisionalLaunch: vi.fn<(args: BeginArgs) => Launch | null>(),
    prepareAiVaultSessionForResume: vi.fn<() => Promise<{ sessionId: string }>>(),
    activateAndRevealWorkspace: vi.fn<(workspaceId: string) => unknown>(),
    toastError: vi.fn<(message: string) => void>(),
    admitStructuredLaunchOnHost:
      vi.fn<(target: unknown, worktree: string, agent: string) => Promise<{ kind: string }>>(),
    ...state,
    sleeping: false,
    navigationIndex: 0,
    activeWorktreeId: 'other-worktree'
  }
})

vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch,
  structuredLaunchOwner: (plan: { executionHostId?: ExecutionHostId }) => {
    const executionHostId = plan.executionHostId ?? mocks.owner
    return executionHostId
      ? {
          executionHostId,
          target:
            executionHostId === 'local'
              ? { kind: 'local' }
              : { kind: 'environment', environmentId: executionHostId.slice('runtime:'.length) }
        }
      : null
  }
}))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  admitStructuredLaunchOnHost: mocks.admitStructuredLaunchOnHost
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepareAiVaultSessionForResume
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: mocks.activeWorktreeId,
      worktreeNavHistoryIndex: mocks.navigationIndex,
      sleepingAgentSessionsByPaneKey: mocks.sleeping ? { source: { worktreeId: 'worktree-1' } } : {}
    })
  }
}))

import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'

const session: AiVaultSession = {
  id: 'vault-1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'vault-1',
  title: 'Vault session',
  cwd: '/x',
  branch: null,
  model: null,
  filePath: '/x',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2025-01-01T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 1,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'resume',
  subagent: null
}

describe('resumeAiVaultSessionInNewChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.owner = 'local'
    mocks.sleeping = false
    mocks.navigationIndex = 0
    mocks.activeWorktreeId = 'other-worktree'
    mocks.prepareAiVaultSessionForResume.mockResolvedValue({ sessionId: 'provider-1' })
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return {
        sessionId: 'session-1',
        tab: { id: 'agent-session:session-1' },
        settlement: Promise.resolve({ kind: 'structured', sessionId: 'session-1' })
      }
    })
  })

  it('keeps the recording server when workspace selection changes during preparation', async () => {
    mocks.owner = 'runtime:server-1'
    let finish!: (value: { sessionId: string }) => void
    mocks.prepareAiVaultSessionForResume.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    mocks.admitStructuredLaunchOnHost.mockResolvedValue({ kind: 'admitted' })
    const launched = resumeAiVaultSessionInNewChat(
      { ...session, executionHostId: 'runtime:server-1' },
      'opencode2',
      'worktree-1',
      'resume-click'
    )
    mocks.owner = 'runtime:server-2'
    mocks.activeWorktreeId = 'worktree-1'
    finish({ sessionId: 'provider-1' })
    await launched
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('worktree-1', {
      executionHostId: 'runtime:server-1'
    })
    expect(mocks.admitStructuredLaunchOnHost).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'id:worktree-1',
      'opencode2'
    )
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ executionHostId: 'runtime:server-1' })
      })
    )
  })

  it.each(['local', 'runtime:server-2', null] as const)(
    'refuses a recording-host mismatch before preparing history: %s',
    async (owner) => {
      mocks.owner = owner
      await resumeAiVaultSessionInNewChat(
        { ...session, executionHostId: 'runtime:server-1' },
        'codex',
        'worktree-1',
        'resume-click'
      )
      expect(mocks.prepareAiVaultSessionForResume).not.toHaveBeenCalled()
      expect(mocks.beginStructuredAgentSessionProvisionalLaunch).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledOnce()
    }
  )

  it.each(['ssh:relay', 'runtime:unresolved-owner'] as const)(
    'does not prepare a conversation from a non-runtime owner: %s',
    async (executionHostId) => {
      mocks.owner = executionHostId
      await resumeAiVaultSessionInNewChat(
        { ...session, executionHostId },
        'codex',
        'worktree-1',
        'resume-click'
      )
      expect(mocks.prepareAiVaultSessionForResume).not.toHaveBeenCalled()
      expect(mocks.beginStructuredAgentSessionProvisionalLaunch).not.toHaveBeenCalled()
    }
  )

  it('reveals the workspace and opens chat before provider settlement', async () => {
    let settle!: (value: StructuredAgentLaunchSettlement) => void
    const settlement = new Promise<StructuredAgentLaunchSettlement>((resolve) => {
      settle = resolve
    })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' }, settlement }
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1', 'resume-click')

    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ resumeFrom: { providerSessionId: 'provider-1' } }),
        hooks: {}
      })
    )
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('worktree-1', {
      executionHostId: 'local'
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
    settle({ kind: 'structured', sessionId: 'session-1' })
  })

  // Where `opencode` is 1.x, only the OpenCode 2 chat can load a 2.x conversation.
  it.each([
    ['admitted', 'opencode2'],
    ['declined', 'opencode'],
    // Not a refusal: switching would start `opencode`, which may be 1.x.
    ['unreachable', 'opencode2'],
    ['workspace-unresolved', 'opencode2']
  ])(
    'opens an OpenCode 2 row in the OpenCode 2 chat, else an OpenCode chat (%s)',
    async (kind, agent) => {
      mocks.admitStructuredLaunchOnHost.mockResolvedValue({ kind })
      await resumeAiVaultSessionInNewChat(session, 'opencode2', 'worktree-1', 'resume-click')

      expect(mocks.admitStructuredLaunchOnHost).toHaveBeenCalledExactlyOnceWith(
        { kind: 'local' },
        'id:worktree-1',
        'opencode2'
      )
      expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ plan: expect.objectContaining({ agent }) })
      )
    }
  )

  it('asks the host nothing for a row only one chat takes over', async () => {
    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1', 'resume-click')
    expect(mocks.admitStructuredLaunchOnHost).not.toHaveBeenCalled()
  })

  it.each(['refusal', 'success', 'newer-navigation'] as const)(
    'keeps sleeping History cold until actual creation: %s',
    async (outcome) => {
      mocks.sleeping = true
      let settle!: (value: StructuredAgentLaunchSettlement) => void
      const settlement = new Promise<StructuredAgentLaunchSettlement>((resolve) => {
        settle = resolve
      })
      mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
        args.beforeOpen?.('session-1')
        return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' }, settlement }
      })
      await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1', 'resume-click')
      expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
      if (outcome === 'newer-navigation') {
        mocks.navigationIndex += 1
      }
      settle(
        outcome === 'refusal'
          ? { kind: 'failed', error: new Error('refused') }
          : { kind: 'structured', sessionId: 'session-1' }
      )
      await settlement
      expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
      expect(mocks.toastError).toHaveBeenCalledTimes(outcome === 'refusal' ? 1 : 0)
    }
  )

  it.each([
    ['agent_session_conflict', undefined, 'Another chat is already holding this conversation.'],
    [
      'agent_session_conflict',
      'conversationHeldElsewhere',
      'Codex is already running this conversation in another terminal. Quit Codex there or close that terminal, then open this conversation from Session History.'
    ],
    [
      'agent_session_identity_required',
      'transcriptNotFound',
      "Codex hasn't saved this conversation yet. Try again after it replies."
    ],
    [
      'agent_session_identity_required',
      'transcriptUnreadable',
      "This conversation's history could not be loaded, so it cannot be resumed in chat."
    ]
  ])('toasts the eventual %s refusal', async (code, reason, message) => {
    const error = Object.assign(new Error('Host diagnostic'), {
      code,
      ...(reason ? { refusal: { code, details: { reason } } } : {})
    })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'failed', error })
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1', 'resume-click')
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(message))
  })

  it('keeps unknown outcomes silent for reconciliation', async () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'visibility-unknown', sessionId: 'session-1' })
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1', 'resume-click')
    await Promise.resolve()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
