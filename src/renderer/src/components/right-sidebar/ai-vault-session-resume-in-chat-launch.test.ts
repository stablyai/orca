import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settleStructuredAgentLaunch: vi.fn(),
  prepareAiVaultSessionForResume: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  activateAndRevealFolderWorkspace: vi.fn(),
  toastError: vi.fn(),
  resolveAiVaultSessionResumeInChatOwner: vi.fn(),
  structuredAgentSessionOwnerMatchesPairing: vi.fn(),
  activeWorktreeId: 'other-worktree'
}))

vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: mocks.settleStructuredAgentLaunch
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepareAiVaultSessionForResume
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree,
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('./ai-vault-session-resume-in-chat-owner', () => ({
  resolveAiVaultSessionResumeInChatOwner: mocks.resolveAiVaultSessionResumeInChatOwner
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionOwnerMatchesPairing: mocks.structuredAgentSessionOwnerMatchesPairing
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ activeWorktreeId: mocks.activeWorktreeId }) }
}))

import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'

const session = {
  agent: 'codex',
  sessionId: 'vault-1',
  filePath: '/x',
  executionHostId: 'runtime:env-1'
} as never
const OWNER = { kind: 'environment', environmentId: 'env-1', pairingRevision: 7 }

describe('resumeAiVaultSessionInNewChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepareAiVaultSessionForResume.mockResolvedValue({ sessionId: 'provider-1' })
    mocks.resolveAiVaultSessionResumeInChatOwner.mockReturnValue({
      adoptable: true,
      executionHostId: 'runtime:env-1',
      owner: OWNER
    })
    mocks.structuredAgentSessionOwnerMatchesPairing.mockReturnValue(true)
  })

  it('adopts the prepared conversation with no legacy fallback and reveals the workspace', async () => {
    mocks.settleStructuredAgentLaunch.mockResolvedValue({ kind: 'structured', sessionId: 's' })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'worktree-1',
      'codex',
      { resumeFrom: { providerSessionId: 'provider-1' } },
      {}
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1')
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

  it.each([
    [
      'resume-history',
      "This conversation's host cannot resume a past conversation in a chat. Update it and try again."
    ],
    [
      'owner-mismatch',
      'This conversation belongs to a different host. Open a workspace on that host to resume it.'
    ]
  ])('sends nothing at all when the owner verdict is %s', async (reason, message) => {
    mocks.resolveAiVaultSessionResumeInChatOwner.mockReturnValue({
      adoptable: false,
      executionHostId: 'runtime:env-1',
      reason
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    // Not even the preparation runs: an older host would answer the unknown `resumeFrom` with a
    // schema error the client cannot tell from a refusal, so nothing may be sent to find out.
    expect(mocks.prepareAiVaultSessionForResume).not.toHaveBeenCalled()
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(message)
  })

  it('withdraws the adoption when the host is re-paired while preparation runs', async () => {
    mocks.structuredAgentSessionOwnerMatchesPairing.mockReturnValue(false)

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.structuredAgentSessionOwnerMatchesPairing).toHaveBeenCalledWith(OWNER)
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This conversation's host was reconnected while Orca was preparing the resume. Try again."
    )
  })

  it('carries the pinned owner into the verdict it adopts', async () => {
    mocks.settleStructuredAgentLaunch.mockResolvedValue({ kind: 'structured', sessionId: 's' })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.resolveAiVaultSessionResumeInChatOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionExecutionHostId: 'runtime:env-1',
        targetWorkspaceId: 'worktree-1'
      })
    )
    // The pin is read once, before the await, and checked again after it — never re-resolved.
    expect(mocks.resolveAiVaultSessionResumeInChatOwner).toHaveBeenCalledTimes(1)
  })
})
