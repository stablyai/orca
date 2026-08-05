// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo, Worktree } from '../../../../shared/types'
import type { CursorCommandState } from '@/lib/ai-vault-cursor-command'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import { useAiVaultSessionResumeControls } from './use-ai-vault-session-resume-controls'

const WORKTREE_ID = 'repo-1::/repo/orca'

function makeWorktree(): Worktree {
  return {
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
  }
}

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo/orca',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1
  }
}

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:cursor:session-1',
    executionHostId: 'local',
    agent: 'cursor',
    sessionId: 'session-1',
    title: 'Session',
    cwd: '/repo/orca',
    branch: null,
    model: null,
    filePath: '/home/ada/.cursor/chats/bucket/session-1/meta.json',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-30T00:00:00.000Z',
    messageCount: 4,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: "cursor-agent --resume 'session-1'",
    subagent: null,
    ...overrides
  }
}

function makeTargetState(
  detectedAgentCommandsByContext: CursorCommandState['detectedAgentCommandsByContext'] = {}
): AiVaultSessionResumeTargetState & CursorCommandState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [makeRepo()],
    settings: {} as CursorCommandState['settings'],
    worktreesByRepo: { 'repo-1': [makeWorktree()] },
    detectedAgentCommandsByContext
  } as AiVaultSessionResumeTargetState & CursorCommandState
}

function renderControls(args: {
  targetState?: AiVaultSessionResumeTargetState & CursorCommandState
  cursorCommandOverride?: string | null
  activeWorktreeId?: string | null
  worktrees?: readonly Worktree[]
}) {
  return renderHook(() =>
    useAiVaultSessionResumeControls({
      activeWorktreeId: args.activeWorktreeId === undefined ? WORKTREE_ID : args.activeWorktreeId,
      worktrees: args.worktrees ?? [makeWorktree()],
      repos: [makeRepo()],
      targetState: args.targetState ?? makeTargetState(),
      cursorCommandOverride: args.cursorCommandOverride,
      getSessionWorktreeInfo: () => null
    })
  ).result.current
}

describe('useAiVaultSessionResumeControls', () => {
  it('leaves non-cursor sessions ungated by cursor detection', () => {
    const controls = renderControls({})
    const session = makeSession({ agent: 'claude', filePath: '/home/ada/.claude/s.jsonl' })
    expect(controls.getSessionResumeState(session)).not.toHaveProperty('cursorCommandAvailable')
    expect(controls.getSessionResumeActions(session).newTab.disabled).toBe(false)
  })

  it('blocks cursor resume when the host inventory has no cursor command', () => {
    const controls = renderControls({})
    const session = makeSession()
    expect(controls.getSessionResumeState(session)).toMatchObject({
      blocked: false,
      worktreeId: WORKTREE_ID,
      cursorCommandAvailable: false
    })
    expect(controls.getSessionResumeActions(session).newTab.disabled).toBe(true)
  })

  it('enables cursor resume from the detected host command', () => {
    const controls = renderControls({
      targetState: makeTargetState({ host: { cursor: 'cursor-agent' } })
    })
    const session = makeSession()
    expect(controls.getSessionResumeState(session).cursorCommandAvailable).toBe(true)
    expect(controls.getSessionResumeActions(session).newTab.disabled).toBe(false)
  })

  it('enables cursor resume from an explicit override without detection', () => {
    const controls = renderControls({ cursorCommandOverride: 'cursor-agent' })
    const session = makeSession()
    expect(controls.getSessionResumeState(session).cursorCommandAvailable).toBe(true)
    expect(controls.getSessionResumeActions(session).newTab.disabled).toBe(false)
  })

  it('reports no cursor command when there is no resume worktree', () => {
    const controls = renderControls({
      targetState: makeTargetState({ host: { cursor: 'cursor-agent' } }),
      activeWorktreeId: null,
      worktrees: []
    })
    const session = makeSession()
    const state = controls.getSessionResumeState(session)
    expect(state.worktreeId).toBeNull()
    expect(state.cursorCommandAvailable).toBe(false)
    const actions = controls.getSessionResumeActions(session)
    expect(actions.worktree.disabled).toBe(true)
    expect(actions.newTab.disabled).toBe(true)
  })
})
