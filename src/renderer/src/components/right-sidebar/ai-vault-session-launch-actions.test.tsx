// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  startStructuredAgentLaunch: vi.fn(() => ({ sessionId: 's', launchResult: Promise.resolve() })),
  prepare: vi.fn(async (session: AiVaultSession) => session)
}))

vi.mock('sonner', () => ({ toast: { error: mocks.error, success: mocks.success } }))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepare
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn()
}))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: vi.fn() }))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  buildAiVaultResumeCopyCommandForWorktree: vi.fn(() => ''),
  buildAiVaultResumeStartupForWorktree: vi.fn(() => ({}))
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ activeWorktreeId: 'repo-1::/repo/orca' }) }
}))

const WORKTREE_ID = 'repo-1::/repo/orca'

function targetState(known: boolean): AiVaultSessionResumeTargetState {
  const worktree = {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    displayName: 'orca',
    path: '/repo/orca',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    isMainWorktree: false
  } as Worktree
  const repo = { id: 'repo-1', path: '/repo/orca', displayName: 'orca' } as Repo
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: known ? [repo] : [],
    worktreesByRepo: known ? { 'repo-1': [worktree] } : {}
  } as AiVaultSessionResumeTargetState
}

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:session-1',
    agent: 'claude',
    sessionId: 'session-1',
    cwd: '/repo/orca',
    filePath: '/home/dev/.claude/projects/-repo-orca/session-1.jsonl',
    executionHostId: 'local',
    messageCount: 4,
    previewMessages: [],
    ...overrides
  } as AiVaultSession
}

function actions(known: boolean) {
  return renderHook(() =>
    useAiVaultSessionLaunchActions({
      activeWorktree: null,
      activeWorktreeId: WORKTREE_ID,
      targetState: targetState(known)
    })
  ).result
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleResumeInNewChat validates its target like its siblings', () => {
  it('launches into a workspace the client can place', async () => {
    const result = actions(true)
    result.current.handleResumeInNewChat(session(), WORKTREE_ID)
    await vi.waitFor(() => expect(mocks.startStructuredAgentLaunch).toHaveBeenCalled())
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith(WORKTREE_ID, 'claude', {
      resumeFrom: { providerSessionId: 'session-1' }
    })
  })

  it('refuses a workspace the client does not know', async () => {
    const result = actions(false)
    result.current.handleResumeInNewChat(session(), WORKTREE_ID)
    await Promise.resolve()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith('Open a workspace before resuming a session.')
  })

  it('refuses a session recorded on another host', async () => {
    const result = actions(true)
    result.current.handleResumeInNewChat(session({ executionHostId: 'ssh:build-box' }), WORKTREE_ID)
    await Promise.resolve()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(
      'This session belongs to a different host. Open a workspace on the same host to resume it.'
    )
  })

  it('ignores an agent with no structured lane', () => {
    const result = actions(true)
    result.current.handleResumeInNewChat(session({ agent: 'opencode' }), WORKTREE_ID)
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
