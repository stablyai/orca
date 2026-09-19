/**
 * The acceptance matrix: a finished structured chat must light exactly what a finished PTY agent
 * lights, on the same rules. The PTY control runs in the same mixed workspace and the same test
 * run, because "the chat marks something" is only the claim if a terminal beside it marks the
 * same things from the same store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { StructuredTurnCompletion } from '../../../../shared/structured-turn-completion'
import { structuredTurnCompletionKey } from '../../../../shared/structured-turn-completion'

const WORKSPACE = 'wt-primary'
const OTHER_WORKSPACE = 'wt-secondary'
const FOLDER_WORKSPACE = 'folder:folder-1'
const GROUP = 'group-1'
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'
const CHAT_PANE_KEY = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)
const TERMINAL_TAB = 'term-tab'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TERMINAL_PANE_KEY = makePaneKey(TERMINAL_TAB, LEAF)

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: WORKSPACE,
  workspaceKind: 'git-worktree'
} as const

function completion(overrides: Partial<StructuredTurnCompletion> = {}): StructuredTurnCompletion {
  return {
    scope: SCOPE,
    sessionId: SESSION,
    turnId: 'turn-1',
    outcome: 'success',
    completedAt: 1_700,
    ...overrides
  }
}

function agentRow(paneKey: string, tabId: string, workspaceId: string): AgentStatusEntry {
  const now = 1_000
  return {
    state: 'done',
    prompt: 'do the thing',
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'claude',
    paneKey,
    tabId,
    worktreeId: workspaceId,
    terminalTitle: 'claude',
    stateHistory: [],
    lastAssistantMessage: 'Done.'
  }
}

type Seed = {
  /** Which tab the workspace's focused group is showing. */
  visible?: 'chat' | 'terminal'
  /** In-app workspace selection; the default leaves the target workspace backgrounded. */
  activeWorktreeId?: string | null
  /** The session the chat tab is currently bound to. */
  boundSession?: string
  chatTab?: boolean
  groupAttentionEnabled?: boolean
  /** Which workspace holds the tabs. A `folder:` key exercises the folder-workspace paths. */
  workspaceId?: string
}

type UnifiedTabRow = {
  id: string
  worktreeId: string
  groupId: string
  contentType: string
  entityId?: string
  agentSessionAgent?: string
  label?: string
}

type TabGroupRow = {
  id: string
  worktreeId: string
  activeTabId: string
  tabOrder: string[]
}

function buildState(seed: Seed = {}) {
  const workspace = seed.workspaceId ?? WORKSPACE
  const unifiedTabs: UnifiedTabRow[] = [
    {
      id: TERMINAL_TAB,
      worktreeId: workspace,
      groupId: GROUP,
      contentType: 'terminal'
    },
    ...(seed.chatTab === false
      ? []
      : [
          {
            id: CHAT_TAB,
            worktreeId: workspace,
            groupId: GROUP,
            contentType: 'agent-session',
            entityId: seed.boundSession ?? SESSION,
            agentSessionAgent: 'claude',
            label: 'Fix auth'
          }
        ])
  ]
  const groups: TabGroupRow[] = [
    {
      id: GROUP,
      worktreeId: workspace,
      activeTabId: seed.visible === 'chat' ? CHAT_TAB : TERMINAL_TAB,
      tabOrder: [TERMINAL_TAB, CHAT_TAB]
    }
  ]
  const activeGroupIdByWorktree: Record<string, string> = {
    [workspace]: GROUP
  }
  const groupsByWorktree: Record<string, TabGroupRow[]> = {
    [workspace]: groups
  }
  const unifiedTabsByWorktree: Record<string, UnifiedTabRow[]> = {
    [workspace]: unifiedTabs
  }
  const tabsByWorktree: Record<string, { id: string; ptyId: string }[]> = {
    [workspace]: [{ id: TERMINAL_TAB, ptyId: 'pty-1' }]
  }
  return {
    activeWorktreeId: seed.activeWorktreeId === undefined ? OTHER_WORKSPACE : seed.activeWorktreeId,
    activeTabId: TERMINAL_TAB,
    activeGroupIdByWorktree,
    groupsByWorktree,
    unifiedTabsByWorktree,
    tabsByWorktree,
    ptyIdsByTabId: { [TERMINAL_TAB]: ['pty-1'] },
    suppressedPtyExitIds: {},
    terminalLayoutsByTabId: {
      [TERMINAL_TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    browserTabsByWorktree: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    retainedAgentsByPaneKey: {},
    agentStatusByPaneKey: {
      [CHAT_PANE_KEY]: agentRow(CHAT_PANE_KEY, CHAT_TAB, workspace),
      [TERMINAL_PANE_KEY]: agentRow(TERMINAL_PANE_KEY, TERMINAL_TAB, workspace)
    },
    folderWorkspaces: [
      {
        id: 'folder-1',
        name: 'notes',
        projectGroupId: 'pg-1',
        executionHostId: 'local'
      }
    ],
    projectGroups: [{ id: 'pg-1', name: 'Notebook', executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [
        {
          id: WORKSPACE,
          repoId: 'repo1',
          displayName: 'master',
          branch: 'master'
        },
        {
          id: OTHER_WORKSPACE,
          repoId: 'repo1',
          displayName: 'other',
          branch: 'other'
        }
      ]
    },
    repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
    settings: {
      experimentalTerminalAttention: seed.groupAttentionEnabled !== false,
      notifications: { customSoundId: 'system', customSoundVolume: null }
    },
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    markAgentCompletionPaneUnread: vi.fn()
  }
}

let state: ReturnType<typeof buildState>

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn()
}))
vi.mock('@/lib/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))

const { dispatchStructuredTurnCompletion } = await import('./structured-turn-completion-attention')
const { dispatchTerminalNotification } = await import('../terminal-pane/use-notification-dispatch')

/** Every marker write the attention sinks made, as one comparable record. */
function marks(seeded: ReturnType<typeof buildState>): Record<string, unknown[]> {
  return {
    workspace: seeded.markWorktreeUnread.mock.calls.map(([id]) => id),
    subject: seeded.markAgentCompletionPaneUnread.mock.calls.map(([key]) => key),
    group: seeded.markTerminalTabUnread.mock.calls.map(([id]) => id),
    surface: seeded.markTerminalPaneUnread.mock.calls.map(([key]) => key)
  }
}

/** Which markers were written and how many times, with the addresses dropped. */
function markerShape(record: Record<string, unknown[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.length]))
}

const NOTHING_LIT = { workspace: [], subject: [], group: [], surface: [] }

/** Held directly rather than read back off the window stub, so no cast is needed to see it. */
const notificationDispatch = vi.fn<(request: NotificationDispatchRequest) => Promise<unknown>>()

function lastDispatchRequest(): NotificationDispatchRequest | undefined {
  return notificationDispatch.mock.calls.at(-1)?.[0]
}

function seed(options: Seed = {}): ReturnType<typeof buildState> {
  state = buildState(options)
  return state
}

function completeChat(
  workspaceId = WORKSPACE,
  outcome: StructuredTurnCompletion['outcome'] = 'success'
): void {
  dispatchStructuredTurnCompletion(
    completion({
      outcome,
      scope: {
        ...SCOPE,
        workspaceId,
        workspaceKind: workspaceId.startsWith('folder:') ? 'folder' : 'git-worktree'
      }
    }),
    { workspaceId, paneKey: CHAT_PANE_KEY, label: 'Fix auth' }
  )
}

function completeTerminal(workspaceId = WORKSPACE): void {
  dispatchTerminalNotification(workspaceId, {
    source: 'agent-task-complete',
    paneKey: TERMINAL_PANE_KEY,
    agentStatusSnapshot: agentRow(TERMINAL_PANE_KEY, TERMINAL_TAB, workspaceId)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  notificationDispatch.mockResolvedValue({ delivered: true })
  vi.stubGlobal('window', {
    api: { notifications: { dispatch: notificationDispatch } }
  })
  // Orca in the background: unread is exactly what a user who cannot see the app needs.
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    hasFocus: vi.fn(() => false)
  })
  seed()
})

describe('a successful structured turn on a backgrounded workspace', () => {
  it('lights the same markers a PTY agent lights, in the same run and the same workspace', () => {
    completeChat()
    const chat = marks(state)

    const control = seed()
    completeTerminal()
    const terminal = marks(control)

    // Workspace bold, the amber pane dot, the tab dot and the surface marker — the chat writes
    // every one the terminal does, each addressed to its own surface.
    expect(chat).toEqual({
      workspace: [WORKSPACE],
      subject: [CHAT_PANE_KEY],
      group: [CHAT_TAB],
      surface: [CHAT_PANE_KEY]
    })
    expect(terminal).toEqual({
      workspace: [WORKSPACE],
      subject: [TERMINAL_PANE_KEY],
      group: [TERMINAL_TAB],
      surface: [TERMINAL_PANE_KEY]
    })
    // Stated as a shape comparison too, so a change that drops one of the four from the chat path
    // fails here even if someone updates the literal above to match.
    expect(markerShape(chat)).toEqual(markerShape(terminal))
  })

  it('requests delivery carrying the completion identity for mobile dedupe', () => {
    completeChat()

    expect(lastDispatchRequest()).toMatchObject({
      source: 'agent-task-complete',
      worktreeId: WORKSPACE,
      paneKey: CHAT_PANE_KEY,
      worktreeLabel: 'master',
      repoLabel: 'orca',
      isActiveWorktree: false,
      mobileDedupeKey: structuredTurnCompletionKey(completion())
    })
  })

  it('keys mobile dedupe on scope AND session AND turn, never on the turn id alone', () => {
    const base = completion()
    expect(structuredTurnCompletionKey(base)).toBe(structuredTurnCompletionKey(completion()))
    for (const other of [
      completion({ turnId: 'turn-2' }),
      completion({ sessionId: 'session-2' }),
      completion({ scope: { ...SCOPE, executionHostId: 'ssh:box' } }),
      completion({ scope: { ...SCOPE, wslDistro: 'Ubuntu' } })
    ]) {
      expect(structuredTurnCompletionKey(other)).not.toBe(structuredTurnCompletionKey(base))
    }
  })
})

describe('a turn that did not succeed', () => {
  it.each(['failure', 'cancellation'] as const)('lights nothing for %s', (outcome) => {
    completeChat(WORKSPACE, outcome)

    expect(marks(state)).toEqual(NOTHING_LIT)
    expect(lastDispatchRequest()).toBeUndefined()
  })
})

describe('visibility', () => {
  it('writes no unread when the chat itself is the focused surface on screen', () => {
    seed({ visible: 'chat', activeWorktreeId: WORKSPACE })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: vi.fn(() => true)
    })

    completeChat()

    expect(marks(state)).toEqual(NOTHING_LIT)
    // A viewed surface suppresses UNREAD, not the delivery request: main owns the
    // suppress-while-focused preference, and a paired phone may still need the alert.
    expect(lastDispatchRequest()).toMatchObject({ isActiveWorktree: true })
  })

  it('still marks a hidden chat tab inside the focused workspace', () => {
    // The distinction the acceptance criteria turn on: the workspace is focused and on screen,
    // but its group is showing the terminal, so the chat is a hidden sibling.
    seed({ visible: 'terminal', activeWorktreeId: WORKSPACE })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: vi.fn(() => true)
    })

    completeChat()

    expect(marks(state)).toEqual({
      workspace: [WORKSPACE],
      subject: [CHAT_PANE_KEY],
      group: [CHAT_TAB],
      surface: [CHAT_PANE_KEY]
    })
  })

  it('marks a selected-but-backgrounded workspace, because selection is not visibility', () => {
    seed({ visible: 'chat', activeWorktreeId: WORKSPACE })

    completeChat()

    expect(marks(state).workspace).toEqual([WORKSPACE])
  })
})

describe('workspace kinds', () => {
  it('marks a folder workspace, which is no git worktree and has no branch to name', () => {
    // Folder workspaces reach every one of these paths: the surface reads the same unified tab
    // index, and the notification labels resolve through the folder catalog, not a repo.
    seed({ workspaceId: FOLDER_WORKSPACE })

    completeChat(FOLDER_WORKSPACE)

    expect(marks(state)).toEqual({
      workspace: [FOLDER_WORKSPACE],
      subject: [CHAT_PANE_KEY],
      group: [CHAT_TAB],
      surface: [CHAT_PANE_KEY]
    })
    expect(lastDispatchRequest()).toMatchObject({
      worktreeId: FOLDER_WORKSPACE,
      worktreeLabel: 'notes'
    })
  })
})

describe('addressing', () => {
  it('rejects a completion whose chat tab is gone', () => {
    seed({ chatTab: false })

    completeChat()

    expect(marks(state)).toEqual(NOTHING_LIT)
    expect(lastDispatchRequest()).toBeUndefined()
  })

  it('rejects a completion for a session the tab has since been rebound away from', () => {
    seed({ boundSession: 'session-other' })

    completeChat()

    expect(marks(state)).toEqual(NOTHING_LIT)
  })

  it('holds the container marker behind the same setting the terminal path does', () => {
    seed({ groupAttentionEnabled: false })
    completeChat()
    const chat = marks(state)

    const control = seed({ groupAttentionEnabled: false })
    completeTerminal()

    // Workspace bold and the amber pane dot are unconditional; the tab dot is presentation
    // policy, gated identically for both surface kinds.
    expect(chat).toEqual({
      workspace: [WORKSPACE],
      subject: [CHAT_PANE_KEY],
      group: [],
      surface: []
    })
    expect(marks(control).group).toEqual([])
  })
})
