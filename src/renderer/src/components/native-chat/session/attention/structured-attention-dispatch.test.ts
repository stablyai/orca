// Use real unread/acknowledgment reducers so broken wiring cannot pass on mocked sink call counts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/attention/agent-auto-ack-presence'
import type { Bot, BotNotifications } from '../../../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { AgentSessionTurnCompletion } from '../../../../../../shared/agent-session/view/agent-session-turn-completion-wire'

import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import type { NotificationDispatchRequest } from '../../../../../../shared/notifications/notification-settings-types'
import type { StructuredTab } from '../status/structured-agent-session-tabs'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import type * as BotBackgroundSessionsModule from '../../../bots/bot-background-sessions'
import { botBackgroundSessionTabs } from '../../../bots/bot-background-sessions'
import { publishBotGroups } from '@/lib/bot-group-catalog-snapshot'
import type { BotGroup } from '../../../../../../shared/bots/bot-group'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'

beforeEach(() => setPresenceGated(false))
afterEach(() => setPresenceGated(true))

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/lib/notifications/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn(async () => false)
}))
vi.mock('@/lib/notifications/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))
const testBots = vi.hoisted(() => {
  const current: { id?: string; folderWorkspaceId: string; notifications: BotNotifications }[] = []
  return { current }
})
vi.mock('@/lib/bot-catalog', () => ({ readBots: () => testBots.current }))
const standIns = vi.hoisted(() => {
  const current: StructuredTab[] = []
  return { current }
})
vi.mock('../../../bots/bot-background-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof BotBackgroundSessionsModule>()),
  readBotBackgroundSessionTabs: () => standIns.current
}))

const store = createTestStore()

const dispatched: NotificationDispatchRequest[] = []
const dismissed: { ids: string[]; paneKeys?: string[] }[] = []

const { dispatchStructuredTurnCompletionAttention } =
  await import('./structured-attention-dispatch')

// Worktree ids encode their repo (`repoId::path`); the unread reducer buckets by that prefix.
const WORKSPACE = 'repo1::/tmp/wt'
const GROUP = 'group-1'
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'

function settingsWith(groupAttention: boolean): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only fields read.
  return {
    experimentalTerminalAttention: groupAttention,
    floatingTerminalEnabled: true
  } as GlobalSettings
}

function completion(overrides?: Partial<AgentSessionTurnCompletion>): AgentSessionTurnCompletion {
  return {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      // Use a distinct host-side workspace id; renderer unread markers must use the tab’s workspace id.
      workspaceId: 'host-side-workspace',
      workspaceKind: 'git-worktree'
    },
    sessionId: SESSION,
    turnId: 'turn-1',
    outcome: 'success',
    completedAt: 1_700,
    ...overrides
  }
}

function seed(overrides?: {
  sessionId?: string
  activeTabId?: string | null
  activeWorktreeId?: string | null
  groupAttention?: boolean
  workspaceId?: string
  folderWorkspaces?: FolderWorkspace[]
  tabs?: boolean
  floatingPanelOpen?: boolean
}): void {
  const workspaceId = overrides?.workspaceId ?? WORKSPACE
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1' })] },
    folderWorkspaces: overrides?.folderWorkspaces ?? [],
    unifiedTabsByWorktree: {
      [workspaceId]:
        overrides?.tabs === false
          ? []
          : [
              makeUnifiedTab({
                id: CHAT_TAB,
                worktreeId: workspaceId,
                groupId: GROUP,
                contentType: 'agent-session',
                entityId: overrides?.sessionId ?? SESSION,
                agentSessionAgent: 'claude'
              })
            ]
    },
    groupsByWorktree: {
      [workspaceId]: [
        makeTabGroup({
          id: GROUP,
          worktreeId: workspaceId,
          activeTabId: overrides?.activeTabId === undefined ? CHAT_TAB : overrides.activeTabId,
          tabOrder: [CHAT_TAB]
        })
      ]
    },
    activeGroupIdByWorktree: { [workspaceId]: GROUP },
    activeView: 'terminal',
    activeWorktreeId:
      overrides?.activeWorktreeId === undefined ? 'other-workspace' : overrides.activeWorktreeId,
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    runtimeAgentOrchestrationByPaneKey: {},
    settings: settingsWith(overrides?.groupAttention ?? true),
    floatingWorkspacePanelOpen: overrides?.floatingPanelOpen ?? false,
    // Persistence is not what this test is about; the folder path would otherwise call out to IPC.
    updateFolderWorkspace: async () => true
  })
}

function onlyDispatch(): NotificationDispatchRequest {
  expect(dispatched).toHaveLength(1)
  return dispatched[0]!
}

function structuredTab(workspaceId = WORKSPACE): StructuredTab {
  const found = (store.getState().unifiedTabsByWorktree[workspaceId] ?? []).find(isStructuredTab)
  if (!found) {
    throw new Error('seed() did not put a structured tab in the store')
  }
  return found
}

function indicators(workspaceId = WORKSPACE): Record<string, unknown> {
  const state = store.getState()
  const subject = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)
  return {
    workspaceBold:
      workspaceId === WORKSPACE
        ? state.worktreesByRepo.repo1?.[0]?.isUnread === true
        : state.folderWorkspaces[0]?.isUnread === true,
    paneDot: state.unreadAgentCompletionPanes[subject],
    tabDot: state.unreadTerminalTabs[CHAT_TAB],
    surfaceDot: state.unreadTerminalPanes[subject]
  }
}

const NOTHING_LIT = {
  workspaceBold: false,
  paneDot: undefined,
  tabDot: undefined,
  surfaceDot: undefined
}

describe('dispatchStructuredTurnCompletionAttention', () => {
  beforeEach(() => {
    dispatched.length = 0
    dismissed.length = 0
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: async (request: NotificationDispatchRequest) => {
            dispatched.push(request)
            return { delivered: true }
          },
          dismiss: async (ids: string[], paneKeys?: string[]) => {
            dismissed.push({ ids, paneKeys })
            return { dismissed: ids.length }
          }
        }
      }
    })
    seed()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a superseded surface when the tab was rebound after the caller read it', () => {
    const staleTab = structuredTab()
    seed({ sessionId: 'session-2' })
    dispatchStructuredTurnCompletionAttention(staleTab, completion())
    expect(indicators()).toEqual(NOTHING_LIT)
  })

  it('lights a folder workspace, which is not a git worktree', () => {
    const folderWorkspaceId = 'folder:fw-1'
    seed({
      workspaceId: folderWorkspaceId,
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'pg-1',
          name: 'Folder workspace',
          folderPath: '/tmp/folder',
          connectionId: null,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    dispatchStructuredTurnCompletionAttention(structuredTab(folderWorkspaceId), completion())
    expect(indicators(folderWorkspaceId)).toEqual({
      workspaceBold: true,
      paneDot: 'agent-completion',
      tabDot: 'agent-completion',
      surfaceDot: 'agent-completion'
    })
  })

  it('follows its bot’s notification switches for the bot’s home', () => {
    const folderWorkspaceId = 'folder:fw-1'
    seed({
      workspaceId: folderWorkspaceId,
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'bots-group',
          name: 'Reviewer',
          folderPath: '/home/me/.orca/bots/reviewer',
          connectionId: null,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    testBots.current = [
      {
        folderWorkspaceId: 'fw-1',
        notifications: { needsPermission: true, taskComplete: false, couldNotFinish: true }
      }
    ]
    try {
      dispatchStructuredTurnCompletionAttention(structuredTab(folderWorkspaceId), completion())
      expect(indicators(folderWorkspaceId)).toEqual(NOTHING_LIT)
      expect(dispatched).toEqual([])

      dispatchStructuredTurnCompletionAttention(
        structuredTab(folderWorkspaceId),
        completion({ turnId: 'turn-2', outcome: 'failure' })
      )
      expect(indicators(folderWorkspaceId).workspaceBold).toBe(true)
      expect(onlyDispatch().agentTurnOutcome).toBe('failure')
    } finally {
      testBots.current = []
    }
  })

  it("reads a group member's reply in its room on screen, never on the bot's own home", () => {
    const folder = (id: string): FolderWorkspace => ({
      id,
      projectGroupId: 'bots-group',
      name: id,
      folderPath: `/home/me/.orca/bots/${id}`,
      connectionId: null,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    })
    const member = 'bot-group-member-1'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only rooms and home are read.
    const group = {
      id: 'group-1',
      folderWorkspaceId: 'group-home',
      members: [{ botId: 'scout', sessionId: member }]
    } as BotGroup
    const scout = {
      id: 'scout',
      folderWorkspaceId: 'scout-home',
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true }
    }
    seed({ workspaceId: 'folder:group-home', tabs: false, activeTabId: 'room-tab' })
    store.setState({
      folderWorkspaces: [folder('scout-home'), folder('group-home')],
      activeWorktreeId: 'folder:group-home',
      unifiedTabsByWorktree: {
        'folder:group-home': [
          makeUnifiedTab({
            id: 'room-tab',
            worktreeId: 'folder:group-home',
            groupId: GROUP,
            contentType: 'room',
            entityId: 'group-1'
          })
        ]
      }
    })
    testBots.current = [scout]
    publishBotGroups([group])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only sessionId, workspaceId and agent.
    const summary = {
      sessionId: member,
      workspaceId: 'folder:scout-home',
      agent: 'claude'
    } as AgentSessionStatusSummary
    standIns.current = [
      ...botBackgroundSessionTabs(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only folderWorkspaceId is read.
        [scout as unknown as Bot],
        [group],
        new Map([[member, summary]]),
        store.getState().unifiedTabsByWorktree
      )
    ]
    try {
      dispatchStructuredTurnCompletionAttention(
        standIns.current[0]!,
        completion({ sessionId: member })
      )
      const state = store.getState()
      expect(state.folderWorkspaces.map((workspace) => workspace.isUnread)).toEqual([false, false])
      expect(state.unreadAgentCompletionPanes).toEqual({})
      expect(onlyDispatch()).toMatchObject({
        worktreeId: 'folder:group-home',
        isActiveWorktree: true
      })
    } finally {
      testBots.current = []
      standIns.current = []
      publishBotGroups([])
    }
  })

  it('keeps unread state but sends no notification for a worktree the user muted', () => {
    store.setState({ notificationsMutedByWorktree: { [WORKSPACE]: true } })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators()).toEqual({
      workspaceBold: true,
      paneDot: 'agent-completion',
      tabDot: 'agent-completion',
      surfaceDot: 'agent-completion'
    })
    expect(dispatched).toEqual([])
  })

  it('keeps unread state but sends no notification for a tab the user muted', () => {
    store.setState({ notificationsMutedByTabId: { [CHAT_TAB]: true } })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators()).toEqual({
      workspaceBold: true,
      paneDot: 'agent-completion',
      tabDot: 'agent-completion',
      surfaceDot: 'agent-completion'
    })
    expect(dispatched).toEqual([])
  })
})
