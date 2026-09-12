import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  prepareAiVaultSessionForResume: vi.fn(),
  settleStructuredAgentLaunch: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  activateAndRevealFolderWorkspace: vi.fn(),
  toastError: vi.fn(),
  state: {
    activeWorktreeId: 'other-worktree',
    activeWorkspaceExecutionHostId: null,
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    runtimeEnvironments: [],
    settings: {
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: false
    },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {}
  }
}))

vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: mocks.settleStructuredAgentLaunch
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepareAiVaultSessionForResume
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree,
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'

const session = { agent: 'codex', sessionId: 'vault-1', filePath: '/x' } as never

describe('resumeAiVaultSessionInNewChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocalRuntimeCapabilitiesForTests([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
    mocks.prepareAiVaultSessionForResume.mockResolvedValue({ sessionId: 'provider-1' })
    mocks.settleStructuredAgentLaunch.mockImplementation(
      async (
        _worktreeId: string,
        _agent: string,
        _options: unknown,
        hooks: { onStructuredReady?: (sessionId: string) => void }
      ) => {
        hooks.onStructuredReady?.('session-1')
        return { kind: 'structured', sessionId: 'session-1' }
      }
    )
  })

  it('adopts an eligible structured conversation even when agent tabs default to terminal', async () => {
    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'worktree-1',
      'codex',
      {
        resumeFrom: { providerSessionId: 'provider-1' },
        notifyFailure: false
      },
      expect.anything()
    )
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('worktree-1', {
      providesInitialSurface: true
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('toasts the conflict message when the launch fails with that code', async () => {
    mocks.settleStructuredAgentLaunch.mockResolvedValue({
      kind: 'failed',
      error: Object.assign(new Error('held'), { code: 'agent_session_conflict' })
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Another chat is already holding this conversation.'
    )
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('stays silent on an unknown outcome so the launch layer can reconcile it', async () => {
    mocks.settleStructuredAgentLaunch.mockResolvedValue({
      kind: 'visibility-unknown',
      sessionId: 's'
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
