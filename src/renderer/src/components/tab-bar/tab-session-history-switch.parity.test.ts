// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { resolveAiVaultHistorySessionResumeState } from '../right-sidebar/ai-vault-session-resume'
import { resolveAiVaultHistoryRowResume } from '../right-sidebar/ai-vault-session-resume-in-chat-workspace'
import { resolveAiVaultSessionSurfaceSwitchTargets } from '../right-sidebar/ai-vault-session-surface-switch'
import {
  useAiVaultSessionWorktreeMap,
  withAiVaultCurrentWorktreeStatus
} from '../right-sidebar/ai-vault-session-worktree'
import {
  resolveTabSessionSwitch,
  type TabSessionHistorySubject
} from './tab-session-history-switch'

// Only the host's answers are staged (its capabilities arrive over IPC at boot, and the chat
// route's own feasibility is pinned elsewhere); the composition both surfaces share runs for real.
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
  ]
}))
vi.mock('@/lib/agent-session-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  structuredAgentSessionLaunchFeasible: () => true
}))

const WORKTREE_ID = 'repo-1::/repo/wt'
const SIBLING_ID = 'repo-1::/repo/sibling'

function row(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'row-1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'claude-session-1',
    title: 'Fix the build',
    cwd: '/repo/wt',
    branch: 'main',
    model: null,
    filePath: '/home/.claude/projects/repo/claude-session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-08T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [{ role: 'user', text: 'Fix the build', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume claude-session-1',
    subagent: null,
    ...overrides
  }
}

function makeState(): AppState {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [makeRepo()],
    settings: { ...getDefaultSettings('/home/me'), experimentalNativeChat: true },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  return useAppStore.getState()
}

/** What AiVaultPanel + AiVaultVirtualRow compute for this row while WORKTREE_ID is active. */
function panelTargets(state: AppState, session: AiVaultSession) {
  const worktrees = getIndexedAllWorktrees(state.worktreesByRepo)
  const { result: worktreeMap } = renderHook(() =>
    useAiVaultSessionWorktreeMap({ sessions: [session], repos: state.repos, worktrees })
  )
  const worktreeInfo = withAiVaultCurrentWorktreeStatus(
    worktreeMap.current.get(session.id) ?? null,
    WORKTREE_ID
  )
  const rowArgs = {
    session,
    worktreeInfo,
    activeWorktreeId: WORKTREE_ID,
    worktrees,
    repos: state.repos,
    targetState: state
  }
  return resolveAiVaultSessionSurfaceSwitchTargets(
    session,
    resolveAiVaultHistorySessionResumeState(rowArgs),
    resolveAiVaultHistoryRowResume({ ...rowArgs, settings: state.settings }).resumeInChat
  )
}

const request = { scopePaths: [], executionHostScope: 'local', sessionLimit: 250 } as const

beforeEach(() => {
  makeState()
})

describe('the tab menu offers exactly what the Session History row offers', () => {
  it('Resume in New Native Chat for a CLI conversation', () => {
    const state = useAppStore.getState()
    const session = row()
    const subject: TabSessionHistorySubject = {
      kind: 'cli',
      agent: 'claude',
      providerSessionId: session.sessionId,
      workspaceId: WORKTREE_ID,
      request
    }
    const panel = panelTargets(state, session)

    expect(panel.resumeInNewChatWorkspaceId).toBe(WORKTREE_ID)
    expect(resolveTabSessionSwitch(state, session, subject)).toEqual({
      action: 'resume-in-new-chat',
      worktreeId: panel.resumeInNewChatWorkspaceId
    })
  })

  it("Resume in New Native Chat in the conversation's own worktree when that differs", () => {
    const state = useAppStore.getState()
    const session = row({ cwd: '/repo/sibling' })
    const panel = panelTargets(state, session)

    expect(panel.resumeInNewChatWorkspaceId).toBe(SIBLING_ID)
    expect(
      resolveTabSessionSwitch(state, session, {
        kind: 'cli',
        agent: 'claude',
        providerSessionId: session.sessionId,
        workspaceId: WORKTREE_ID,
        request
      })
    ).toEqual({ action: 'resume-in-new-chat', worktreeId: SIBLING_ID })
  })

  it('Resume in New CLI for a native chat, and nothing once it has no saved turns', () => {
    const state = useAppStore.getState()
    const subject: TabSessionHistorySubject = {
      kind: 'chat',
      sessionId: 'orca-chat-1',
      workspaceId: WORKTREE_ID,
      request
    }
    const chatRow = row({
      structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
    })
    const panel = panelTargets(state, chatRow)

    expect(panel.resumeInNewCliWorktreeId).toBe(WORKTREE_ID)
    expect(resolveTabSessionSwitch(state, chatRow, subject)).toEqual({
      action: 'resume-in-new-cli',
      worktreeId: panel.resumeInNewCliWorktreeId
    })

    const emptyChat = { ...chatRow, messageCount: 0, previewMessages: [] }
    expect(panelTargets(state, emptyChat).resumeInNewCliWorktreeId).toBeNull()
    expect(resolveTabSessionSwitch(state, emptyChat, subject)).toBeNull()
  })
})
