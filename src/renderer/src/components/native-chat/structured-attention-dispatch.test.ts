// Use real unread/acknowledgment reducers so broken wiring cannot pass on mocked sink call counts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentSessionTurnCompletion } from '../../../../shared/agent-session-wire'
import { agentSessionAttentionKey } from '../../../../shared/agent-session-attention'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
import type { StructuredTab } from './structured-agent-session-tabs'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

beforeEach(() => setPresenceGated(false))
afterEach(() => setPresenceGated(true))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn(async () => false)
}))
vi.mock('@/lib/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
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

  it('leaves the phone to a local host, which pushed it already, and relays for a remote one', () => {
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion(), { kind: 'local' })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion({ turnId: 'turn-2' }), {
      kind: 'environment',
      environmentId: 'env-1'
    })
    expect(dispatched.map((request) => request.mobileDeliveredByHost)).toEqual([true, undefined])
    expect(dispatched.map((request) => request.executionHost)).toEqual([undefined, 'runtime:env-1'])
    expect(dispatched.map((request) => request.attentionKey)).toEqual([
      agentSessionAttentionKey({ type: 'completion', completion: completion() }),
      agentSessionAttentionKey({ type: 'completion', completion: completion({ turnId: 'turn-2' }) })
    ])
  })

  it('uses the receiving paired subscription over the tab’s execution host', () => {
    store.setState({
      runtimeEnvironments: [
        {
          id: 'env-1',
          name: 'Paired server',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'endpoint'
        }
      ]
    })
    dispatchStructuredTurnCompletionAttention(
      { ...structuredTab(), executionHostId: 'local' },
      completion(),
      { kind: 'environment', environmentId: 'env-1' }
    )
    expect(onlyDispatch().notificationSourceId).toBe('runtime:env-1')
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
    // Older hosts may omit outcomes; absence proves neither success nor interruption.
    Reflect.deleteProperty(withoutOutcome, 'outcome')
    dispatchStructuredTurnCompletionAttention(structuredTab(), withoutOutcome)
    expect(indicators()).toEqual(NOTHING_LIT)
    expect(dispatched).toEqual([])
  })

  it('earns no unread while the user is looking at that chat, but still asks main to deliver', () => {
    // Main owns focus suppression; renderer focus must not suppress delivery to paired phones.
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

  it('earns no unread for a floating chat selected in the open floating panel', () => {
    seed({ workspaceId: FLOATING_TERMINAL_WORKTREE_ID, floatingPanelOpen: true })
    dispatchStructuredTurnCompletionAttention(
      structuredTab(FLOATING_TERMINAL_WORKTREE_ID),
      completion()
    )
    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
    expect(store.getState().unreadTerminalTabs).toEqual({})
  })

  it('earns unread for a floating chat while the floating panel is closed', () => {
    seed({ workspaceId: FLOATING_TERMINAL_WORKTREE_ID })
    dispatchStructuredTurnCompletionAttention(
      structuredTab(FLOATING_TERMINAL_WORKTREE_ID),
      completion()
    )
    expect(indicators(FLOATING_TERMINAL_WORKTREE_ID).paneDot).toBe('agent-completion')
  })

  it('earns unread when the workspace chat is behind another top-level view', () => {
    seed({ activeWorktreeId: WORKSPACE })
    store.setState({ activeView: 'tasks' })
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(indicators().paneDot).toBe('agent-completion')
  })

  it('hands main the host verdict, which picks finished, failed or stopped', () => {
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
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

  it('calls back a send refused before any turn, named by its journal item key, as failed', () => {
    dispatchStructuredTurnCompletionAttention(
      structuredTab(),
      completion({ outcome: 'failure', turnId: agentJournalSubmissionKey('m1') })
    )
    expect(indicators().paneDot).toBe('agent-completion')
    expect(onlyDispatch()).toMatchObject({ agentState: 'done', agentTurnOutcome: 'failure' })
  })

  it('asks for input when the host settled a request while a prompt waits on the user', () => {
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion({ awaitingUser: true }))
    expect(indicators().paneDot).toBe('agent-completion')
    expect(onlyDispatch()).toMatchObject({ agentState: 'blocked', agentTurnOutcome: 'success' })

    dispatched.length = 0
    seed()
    dispatchStructuredTurnCompletionAttention(structuredTab(), completion())
    expect(onlyDispatch()).toMatchObject({ agentState: 'done' })
  })

  it('says done even while the status row still reads working, because the host settled the turn', () => {
    // Completion can outrun status projection; row state would wrongly announce settled work as still working.
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

  it('delivers the edge identity as its id, retired by subject when the user reads the chat', () => {
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
    // The same id the host's phone push carries, so retiring it here retires the phone's too.
    expect(onlyDispatch().notificationId).toBe(
      agentSessionAttentionKey({ type: 'completion', completion: completion() })
    )

    store.getState().acknowledgeAgents([paneKey])
    expect(dismissed.flatMap((call) => call.paneKeys ?? [])).toContain(paneKey)
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
