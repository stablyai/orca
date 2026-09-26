import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

type BeginArgs = { beforeOpen?: (sessionId: string) => boolean | void }
type Launch = {
  sessionId: string
  settlement: Promise<StructuredAgentLaunchSettlement>
  tab: { id: string }
}

const mocks = vi.hoisted(() => ({
  beginStructuredAgentSessionProvisionalLaunch: vi.fn<(args: BeginArgs) => Launch | null>(),
  prepareAiVaultSessionForResume: vi.fn<() => Promise<{ sessionId: string }>>(),
  activateAndRevealWorktree: vi.fn<(worktreeId: string) => unknown>(),
  activateAndRevealFolderWorkspace: vi.fn<(workspaceId: string) => unknown>(),
  toastError: vi.fn<(message: string) => void>(),
  activeWorktreeId: 'other-worktree'
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
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
    mocks.prepareAiVaultSessionForResume.mockResolvedValue({ sessionId: 'provider-1' })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return {
        sessionId: 'session-1',
        tab: { id: 'agent-session:session-1' },
        settlement: Promise.resolve({ kind: 'structured', sessionId: 'session-1' })
      }
    })
  })

  it('reveals the workspace and opens chat before provider settlement', async () => {
    let settle!: (value: StructuredAgentLaunchSettlement) => void
    const settlement = new Promise<StructuredAgentLaunchSettlement>((resolve) => {
      settle = resolve
    })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' }, settlement }
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')

    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ resumeFrom: { providerSessionId: 'provider-1' } }),
        hooks: {}
      })
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
    settle({ kind: 'structured', sessionId: 'session-1' })
  })

  it('toasts a conflict reported by the eventual settlement', async () => {
    const error = Object.assign(new Error('held'), { code: 'agent_session_conflict' })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'failed', error })
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Another chat is already holding this conversation.'
      )
    )
  })

  it('keeps unknown outcomes silent for reconciliation', async () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'visibility-unknown', sessionId: 'session-1' })
    })

    await resumeAiVaultSessionInNewChat(session, 'codex', 'worktree-1')
    await Promise.resolve()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
