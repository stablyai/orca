import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type {
  CliWorkspaceProvenance,
  AutomationWorkspaceProvenance
} from '../../../../shared/worktree/types'

// Why: the mocked store state lives here so each split suite's hoisted `vi.mock` factory can
// reach it through a lazy dynamic import (hoisted factories cannot close over imports).

export const LIVE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const STALE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const PANE_KEY = `tab-1:${LIVE_LEAF_ID}`
export const STALE_PANE_KEY = `tab-1:${STALE_LEAF_ID}`

export type NotificationDispatchMockState = {
  activeWorktreeId: string | null
  activeTabId: string | null
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  browserTabsByWorktree: Record<string, unknown[]>
  retainedAgentsByPaneKey: Record<string, { worktreeId: string }>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      displayName?: string
      branch?: string
      workspaceStatus?: string
      cliProvenance?: CliWorkspaceProvenance
      automationProvenance?: AutomationWorkspaceProvenance
    }[]
  >
  repos: { id: string; displayName?: string; connectionId?: string | null }[]
  settings: {
    experimentalTerminalAttention?: boolean
    notifications?: {
      enabled?: boolean
      agentTaskComplete?: boolean
      cliWorktreeTaskComplete?: boolean
      automationWorktreeTaskComplete?: boolean
      customSoundPath?: string | null
      customSoundId?: string | null
    }
  }
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  markAgentCompletionPaneUnread: ReturnType<typeof vi.fn>
}

/** Annotated explicitly so declaration emit never names @vitest/spy internals. */
export const playDesktopNotificationSound: Mock<(...args: never[]) => unknown> = vi.fn()

let mockState: NotificationDispatchMockState = buildNotificationDispatchMockState()

export function getNotificationDispatchMockState(): NotificationDispatchMockState {
  return mockState
}

function buildNotificationDispatchMockState(): NotificationDispatchMockState {
  return {
    activeWorktreeId: 'wt-secondary',
    activeTabId: 'tab-1',
    tabsByWorktree: { 'wt-primary': [{ id: 'tab-1', ptyId: 'pty-1' }] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    suppressedPtyExitIds: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LIVE_LEAF_ID },
        activeLeafId: LIVE_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LIVE_LEAF_ID]: 'pty-1' }
      }
    },
    browserTabsByWorktree: {},
    retainedAgentsByPaneKey: {},
    agentStatusByPaneKey: { [PANE_KEY]: makeAgentStatus(PANE_KEY) },
    worktreesByRepo: {
      repo1: [
        { id: 'wt-primary', repoId: 'repo1', displayName: 'master', branch: 'master' },
        {
          id: 'wt-secondary',
          repoId: 'repo1',
          displayName: 'e2e-secondary',
          branch: 'e2e-secondary'
        }
      ]
    },
    repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
    settings: { experimentalTerminalAttention: true, notifications: { customSoundPath: null } },
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    markAgentCompletionPaneUnread: vi.fn()
  }
}

/** Rebuilds the mocked store and stubs the notification bridge; returns the fresh state. */
export function resetNotificationDispatchMockState(): NotificationDispatchMockState {
  vi.clearAllMocks()
  mockState = buildNotificationDispatchMockState()
  vi.stubGlobal('window', {
    api: { notifications: { dispatch: vi.fn().mockResolvedValue({ delivered: true }) } }
  })
  return mockState
}

export function makeAgentStatus(
  paneKey: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const now = Date.now()
  return {
    state: 'done',
    prompt: 'codex-hook-notify',
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'codex',
    paneKey,
    terminalTitle: 'codex',
    stateHistory: [],
    lastAssistantMessage: 'Done.',
    ...overrides
  }
}

export function stubDocumentFocus({
  visibilityState,
  focused
}: {
  visibilityState: DocumentVisibilityState
  focused: boolean
}): void {
  vi.stubGlobal('document', { visibilityState, hasFocus: vi.fn(() => focused) })
}

export function getLastNotificationDispatchArg(): Record<string, unknown> | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window stub above installs a vi.fn() at this exact path.
  const dispatch = window.api.notifications.dispatch as unknown as ReturnType<typeof vi.fn>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch is only ever called with one NotificationDispatchRequest object.
  return dispatch.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
}

/** Shared `vi.mock` factories; hoisted factories must import this module lazily. */
export function createNotificationDispatchStoreModuleMock(): Record<string, unknown> {
  return { useAppStore: { getState: () => getNotificationDispatchMockState() } }
}

export function createDesktopNotificationSoundModuleMock(): Record<string, unknown> {
  return { playDesktopNotificationSound }
}
