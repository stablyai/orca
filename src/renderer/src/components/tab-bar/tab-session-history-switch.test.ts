import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeRepo, makeTerminalTab, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { makeAgentStatusEntry } from '@/runtime/sync-runtime-graph-test-harness'
import type { AiVaultListArgs, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  claimAiVaultForcedRescan,
  resetAiVaultForcedRescanThrottleForTest
} from '../right-sidebar/ai-vault-session-refresh'
import {
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList
} from '../right-sidebar/ai-vault-session-list-request'
import {
  findTabSessionHistoryRow,
  lookupTabSessionHistoryRow,
  resolveTabSessionHistorySubject,
  resolveTabSessionSwitch,
  type TabSessionHistorySubject
} from './tab-session-history-switch'

const mocks = vi.hoisted(() => {
  const state: {
    resumeState: { blocked: boolean; worktreeId: string | null }
  } = { resumeState: { blocked: false, worktreeId: 'repo-1::/repo/wt' } }
  return { ...state, resumeInChat: vi.fn() }
})

// Parity with the panel's real composition is pinned in tab-session-history-switch.parity.test.ts.
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-workspace', () => ({
  resolveAiVaultHistoryRowResume: () => ({
    resumeState: { ...mocks.resumeState, usesSessionWorktree: true },
    resumeInChat: mocks.resumeInChat()
  })
}))

const WORKTREE_ID = 'repo-1::/repo/wt'

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

const SIBLING_ID = 'repo-1::/repo/sibling'

function makeState(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {},
  repo: Partial<ReturnType<typeof makeRepo>> = {}
): AppState {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey,
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [{ ...makeRepo(), ...repo }],
    tabsByWorktree: { [WORKTREE_ID]: [makeTerminalTab('term-1', WORKTREE_ID, 'claude')] },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  return useAppStore.getState()
}

// What the Session History panel sends for this workspace: every path of its project, at the
// panel's default depth, on the workspace's own host.
const PANEL_REQUEST = {
  scopePaths: ['/repo/wt', '/repo/sibling', '/repos/repo-1'],
  executionHostScope: 'local',
  sessionLimit: 250
} as const

const liveClaudeEntry = {
  'term-1:leaf-1': makeAgentStatusEntry({
    agentType: 'claude',
    paneKey: 'term-1:leaf-1',
    tabId: 'term-1',
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'claude-session-1' }
  })
}

const chatSubject: TabSessionHistorySubject = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: WORKTREE_ID,
  request: PANEL_REQUEST
}

const cliSubject: TabSessionHistorySubject = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'claude-session-1',
  workspaceId: WORKTREE_ID,
  request: PANEL_REQUEST
}

beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  mocks.resumeState = { blocked: false, worktreeId: WORKTREE_ID }
  mocks.resumeInChat.mockReset()
})

describe('resolveTabSessionHistorySubject', () => {
  it('finds a native chat tab by the chat it shows', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(), {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID, launchAgent: 'codex' },
        structuredSessionId: 'orca-chat-1'
      })
    ).toEqual({ ...chatSubject })
  })

  it('skips chats whose agent has no history move', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(), {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID, launchAgent: 'grok' },
        structuredSessionId: 'orca-chat-1'
      })
    ).toBeNull()
  })

  it('finds a terminal tab by the conversation its agent reported', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(liveClaudeEntry), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toEqual(cliSubject)
  })

  it('looks nothing up over SSH, where neither move is ever offered', () => {
    const state = makeState(liveClaudeEntry, { connectionId: 'dev-box' })
    expect(
      resolveTabSessionHistorySubject(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
    ).toBeNull()
    expect(
      resolveTabSessionHistorySubject(state, {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID, launchAgent: 'claude' },
        structuredSessionId: 'orca-chat-1'
      })
    ).toBeNull()
  })

  it('looks a chat up on a remote Orca server, which owns its chats, but never a CLI there', () => {
    const state = makeState(liveClaudeEntry, { executionHostId: 'runtime:server-1' })
    expect(
      resolveTabSessionHistorySubject(state, {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID, launchAgent: 'claude' },
        structuredSessionId: 'orca-chat-1'
      })
    ).toMatchObject({
      kind: 'chat',
      request: { executionHostScope: 'runtime:server-1' }
    })
    expect(
      resolveTabSessionHistorySubject(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
    ).toBeNull()
  })

  it('skips a plain shell tab', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toBeNull()
  })
})

describe('findTabSessionHistoryRow', () => {
  const chatRow = row({
    id: 'chat-row',
    structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
  })
  const cliRow = row({ id: 'cli-row' })

  it('matches a chat tab to the row its chat owns', () => {
    expect(findTabSessionHistoryRow([cliRow, chatRow], chatSubject)?.id).toBe('chat-row')
  })

  it('matches a terminal tab only to an unowned row of the same agent and conversation', () => {
    expect(findTabSessionHistoryRow([chatRow, cliRow], cliSubject)?.id).toBe('cli-row')
    expect(findTabSessionHistoryRow([row({ agent: 'codex' })], cliSubject)).toBeNull()
    expect(
      findTabSessionHistoryRow(
        [
          row({
            subagent: { parentSessionId: 'p', agentType: null, status: null }
          })
        ],
        cliSubject
      )
    ).toBeNull()
  })
})

describe('resolveTabSessionSwitch', () => {
  const chatRow = row({
    structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
  })

  it('offers Resume in New CLI on a chat tab whose row can fork', () => {
    expect(resolveTabSessionSwitch(makeState(), chatRow, chatSubject)).toEqual({
      action: 'resume-in-new-cli',
      worktreeId: WORKTREE_ID
    })
  })

  it('hides Resume in New CLI for an empty or unresumable chat', () => {
    expect(
      resolveTabSessionSwitch(
        makeState(),
        { ...chatRow, messageCount: 0, previewMessages: [] },
        chatSubject
      )
    ).toBeNull()
    mocks.resumeState = { blocked: true, worktreeId: null }
    expect(resolveTabSessionSwitch(makeState(), chatRow, chatSubject)).toBeNull()
  })

  it('offers Resume in New Native Chat where the row is eligible, in the workspace it names', () => {
    mocks.resumeInChat.mockReturnValue({
      available: true,
      workspaceId: WORKTREE_ID
    })
    expect(resolveTabSessionSwitch(makeState(), row(), cliSubject)).toEqual({
      action: 'resume-in-new-chat',
      worktreeId: WORKTREE_ID
    })
    mocks.resumeInChat.mockReturnValue({ available: false, reason: 'empty' })
    expect(resolveTabSessionSwitch(makeState(), row(), cliSubject)).toBeNull()
  })
})

describe('lookupTabSessionHistoryRow', () => {
  const listResult = (sessions: AiVaultSession[], cancelled = false) => ({
    sessions,
    issues: [],
    scannedAt: 'now',
    ...(cancelled ? { cancelled: true as const } : {})
  })
  const emptyRow = row({ messageCount: 0, previewMessages: [] })
  const lookupOptions = { requestToken: 't', isCancelled: () => false }

  it("sends the panel's own request without writing the panel's cache", async () => {
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([row()]))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({
      id: 'row-1'
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith({
      includeAntigravityIdeSessions: true,
      limit: 250,
      unlimited: false,
      scopePaths: PANEL_REQUEST.scopePaths,
      executionHostScope: 'local',
      force: undefined,
      requestToken: 't'
    })
    expect(readCachedAiVaultSessionList(PANEL_REQUEST)).toBeNull()
  })

  it("leaves the panel's cached list as it was, even after a forced rescan", async () => {
    cacheAiVaultSessionList(PANEL_REQUEST, listResult([row({ id: 'panel-row' })]), {
      replaceHostEntries: false
    })
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([emptyRow]))
    await lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)

    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
    expect(readCachedAiVaultSessionList(PANEL_REQUEST)?.sessions.map((s) => s.id)).toEqual([
      'panel-row'
    ])
  })

  it('rescans once on a miss, from the shared forced-rescan budget', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(listResult([emptyRow]))
      .mockResolvedValueOnce(listResult([row()]))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({
      messageCount: 2
    })
    expect(listSessions).toHaveBeenCalledTimes(2)
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
  })

  it('does not force another scan while the budget is spent', async () => {
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([emptyRow]))
    await lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    listSessions.mockClear()
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({
      messageCount: 0
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ force: undefined }))
  })

  it('starts no forced scan once the menu has closed, and leaves the budget free', async () => {
    let menuOpen = true
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => {
      menuOpen = false
      return listResult([emptyRow])
    })
    await lookupTabSessionHistoryRow(cliSubject, listSessions, {
      requestToken: 't',
      isCancelled: () => !menuOpen
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(claimAiVaultForcedRescan()).toBe(true)
  })

  it('forces no scan on a remote Orca server', async () => {
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([]))
    await lookupTabSessionHistoryRow(
      { ...chatSubject, request: { ...PANEL_REQUEST, executionHostScope: 'runtime:server-1' } },
      listSessions,
      lookupOptions
    )
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('reports no answer when the lookup is cancelled', async () => {
    const listSessions = vi.fn().mockResolvedValue(listResult([], true))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toBeUndefined()
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(readCachedAiVaultSessionList(PANEL_REQUEST)).toBeNull()
  })
})
