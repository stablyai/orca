// The acceptance test for A1: a SETTLED structured native chat lights the unread indicators and
// raises one OS notification, whatever the turn's outcome was.
//
// Assertions read the real store slices the sidebar and tab strip render from, not spies on the
// sinks, so a rewiring that stops reaching those slices fails here rather than passing on a call
// count. The store is the real one (`createTestStore`), so the markers go through the same
// reducers production uses, and the acknowledgement round trip runs through the real reducer too.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentSessionTurnCompletion } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
import { isStructuredTab, type StructuredTab } from './structured-agent-session-tabs'

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
// The two client-side follow-ups of a delivery are leaf side effects with their own tests; this
// file is about the request that reaches main and the markers left behind.
vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn(async () => false)
}))
vi.mock('@/lib/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))

const store = createTestStore()

const dispatched: NotificationDispatchRequest[] = []
const dismissed: string[][] = []

const { dispatchStructuredTurnCompletionAttention } =
  await import('./structured-attention-dispatch')

// Worktree ids encode their repo (`repoId::path`); the unread reducer buckets by that prefix.
const WORKSPACE = 'repo1::/tmp/wt'
const GROUP = 'group-1'
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'

function settingsWith(groupAttention: boolean): GlobalSettings {
  // The dispatcher reads exactly one settings field and GlobalSettings has no test factory.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only field read.
  return { experimentalTerminalAttention: groupAttention } as GlobalSettings
}

function completion(overrides?: Partial<AgentSessionTurnCompletion>): AgentSessionTurnCompletion {
  return {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      // Deliberately NOT the renderer's workspace id: the scope names the workspace on the
      // EXECUTION HOST, which over SSH is not the id this store addresses tabs and markers by.
      // Nothing here may key off it.
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
    // Default: the user is looking somewhere else, which is when unread is owed.
    activeWorktreeId:
      overrides?.activeWorktreeId === undefined ? 'other-workspace' : overrides.activeWorktreeId,
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    settings: settingsWith(overrides?.groupAttention ?? true),
    // Persistence is not what this test is about; the folder path would otherwise call out to IPC.
    updateFolderWorkspace: async () => true
  })
}

/** The one dispatch this turn produced; fails loudly rather than returning a stale earlier one. */
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
          dismiss: async (ids: string[]) => {
            dismissed.push(ids)
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

  it('lights workspace bold, the amber pane dot and the tab dot for a successful turn', () => {
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators()).toEqual({
      workspaceBold: true,
      paneDot: 'agent-completion',
      tabDot: 'agent-completion',
      surfaceDot: 'agent-completion'
    })
  })

  it.each(['failure', 'cancellation'] as const)(
    'lights the same indicators for a %s outcome, because the user is still being called back',
    (outcome) => {
      dispatchStructuredTurnCompletionAttention(structuredTab(), completion({ outcome }))
      expect(indicators()).toEqual({
        workspaceBold: true,
        paneDot: 'agent-completion',
        tabDot: 'agent-completion',
        surfaceDot: 'agent-completion'
      })
    }
  )

  it('lights nothing when the outcome is absent, because absent is UNKNOWN and never a verdict', () => {
    const withoutOutcome = completion()
    // The host does not publish one of these. If an older one did, absence must not be read as
    // success OR as interrupted — nobody gave a verdict, so nothing may be announced.
    Reflect.deleteProperty(withoutOutcome, 'outcome')
    dispatchStructuredTurnCompletionAttention(structuredTab(), withoutOutcome)
    expect(indicators()).toEqual(NOTHING_LIT)
    expect(dispatched).toEqual([])
  })

  it('earns no unread while the user is looking at that chat, but still asks main to deliver', () => {
    // Suppressing a banner the user does not need is main's `suppressWhenFocused` decision, and
    // desktop focus must not silence the paired phone. This lane adds no second suppression.
    seed({ activeWorktreeId: WORKSPACE })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators()).toEqual(NOTHING_LIT)
    expect(onlyDispatch().isActiveWorktree).toBe(true)
  })

  it('still earns unread when the workspace is selected but the chat is hidden behind another tab', () => {
    seed({ activeWorktreeId: WORKSPACE, activeTabId: 'other-tab' })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators().paneDot).toBe('agent-completion')
  })

  it('hands main the host verdict, which picks finished, failed or stopped', () => {
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    // 'done' is the host's report that the turn settled, not a reading of the status row: main
    // words a 'working' state as "working", which would announce a finished turn as unfinished.
    expect(onlyDispatch()).toMatchObject({
      source: 'agent-task-complete',
      surface: 'agent-session',
      agentState: 'done',
      agentTurnOutcome: 'success'
    })

    for (const [outcome, turnId] of [
      ['cancellation', 'turn-2'],
      ['failure', 'turn-3']
    ] as const) {
      dispatched.length = 0
      seed()
      dispatchStructuredTurnCompletionAttention(structuredTab(), completion({ outcome, turnId }))
      expect(onlyDispatch()).toMatchObject({ agentState: 'done', agentTurnOutcome: outcome })
    }
  })

  it('says done even while the status row still reads working, because the host settled the turn', () => {
    // The completion can outrun the status re-projection. Sending the row's own state would make
    // main word a finished turn as "working" (notification-options.ts), which is the whole reason
    // the state is taken from the host's report instead.
    const paneKey = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)
    store.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'do the thing',
          updatedAt: 5_000,
          stateStartedAt: 5_000,
          paneKey,
          worktreeId: WORKSPACE,
          agentType: 'claude',
          stateHistory: []
        }
      }
    })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(onlyDispatch()).toMatchObject({ agentState: 'done', agentTurnOutcome: 'success' })
  })

  it('delivers an id the acknowledgement round trip dismisses when the user reads the chat', () => {
    const paneKey = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)
    store.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'done',
          prompt: 'do the thing',
          updatedAt: 5_000,
          stateStartedAt: 5_000,
          paneKey,
          worktreeId: WORKSPACE,
          agentType: 'claude',
          stateHistory: []
        }
      }
    })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    const deliveredId = onlyDispatch().notificationId
    expect(deliveredId).toBeTruthy()

    store.getState().acknowledgeAgents([paneKey])
    expect(dismissed).toEqual([[deliveredId]])
  })

  it('rejects a completion for a session this tab does not own', () => {
    // Otherwise the key minted from the tab would stamp the NEW session's pane with old news.
    seed({ sessionId: 'session-2' })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators()).toEqual(NOTHING_LIT)
    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
  })

  it('rejects a superseded surface when the tab was rebound after the caller read it', () => {
    const staleTab = structuredTab()
    seed({ sessionId: 'session-2' })
    dispatchStructuredTurnCompletionAttention(staleTab, completion())
    expect(indicators()).toEqual(NOTHING_LIT)
  })

  it('rejects an unknown surface when the tab has been closed', () => {
    const closedTab = structuredTab()
    seed({ tabs: false })
    dispatchStructuredTurnCompletionAttention(closedTab, completion())
    expect(indicators()).toEqual(NOTHING_LIT)
  })

  it('withholds only the tab dot when group attention is off, keeping the pane dot', () => {
    // Same presentation gate the PTY lane reads, from the same setting rather than a second one.
    seed({ groupAttention: false })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators()).toEqual({
      workspaceBold: true,
      paneDot: 'agent-completion',
      tabDot: undefined,
      surfaceDot: undefined
    })
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

  it('is idempotent, so a redelivered completion does not stack markers', () => {
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators().paneDot).toBe('agent-completion')
  })
})
