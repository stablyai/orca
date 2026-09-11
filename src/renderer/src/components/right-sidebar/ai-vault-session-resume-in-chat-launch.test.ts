import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  launchAgentSession: vi.fn(),
  prepareAiVaultSessionForResume: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  activateAndRevealFolderWorkspace: vi.fn(),
  toastError: vi.fn(),
  activeWorktreeId: 'other-worktree'
}))

vi.mock('@/lib/launch-agent-session', () => ({
  launchAgentSession: mocks.launchAgentSession
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepareAiVaultSessionForResume
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree,
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ activeWorktreeId: mocks.activeWorktreeId }) }
}))

import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'

const session = { agent: 'codex', sessionId: 'vault-1', filePath: '/x' } as never

describe('resumeAiVaultSessionInNewChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepareAiVaultSessionForResume.mockResolvedValue({ sessionId: 'provider-1' })
  })

  it('adopts the prepared conversation with no legacy fallback and reveals the workspace', async () => {
    mocks.launchAgentSession.mockResolvedValue({ kind: 'structured', sessionId: 's', tabId: 'tab' })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.launchAgentSession).toHaveBeenCalledWith(expect.anything(), {
      agent: 'codex',
      workspaceId: 'worktree-1',
      resumeFrom: { providerSessionId: 'provider-1' },
      visibility: 'reveal',
      launchSource: 'ai_vault_resume',
      terminalFallback: false
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('toasts the conflict message when the launch fails with that code', async () => {
    mocks.launchAgentSession.mockResolvedValue({
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
    mocks.launchAgentSession.mockResolvedValue({
      kind: 'visibility-unknown',
      sessionId: 's'
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
