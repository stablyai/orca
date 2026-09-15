import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { findKnownWorktreeById } from '../../store/slices/worktrees/listing/detected-worktree-meta'

// Why: split out of use-notification-dispatch.test.ts to keep both files under the
// test-file max-lines budget.

type MockState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      displayName?: string
      branch?: string
    }[]
  >
  repos: { id: string; displayName?: string; connectionId?: string | null }[]
  folderWorkspaces: { id: string; projectGroupId: string; name: string; folderPath: string }[]
  detectedWorktreesByRepo: Record<string, unknown[]>
  getKnownWorktreeById: (worktreeId: string) => unknown
  settings: {
    experimentalTerminalAttention?: boolean
    notifications?: {
      customSoundPath?: string | null
      customSoundId?: string | null
    }
  }
  markWorktreeUnread: ReturnType<typeof vi.fn>
}

const playDesktopNotificationSound = vi.hoisted(() => vi.fn())
let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound
}))

function getLastNotificationDispatchArg(): Record<string, unknown> | undefined {
  const dispatch = window.api.notifications.dispatch as unknown as ReturnType<typeof vi.fn>
  return dispatch.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
}

describe('dispatchTerminalNotification folder workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState = {
      activeWorktreeId: 'wt-secondary',
      tabsByWorktree: {
        'wt-primary': [{ id: 'tab-1', ptyId: 'pty-1' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-primary',
            repoId: 'repo1',
            displayName: 'master',
            branch: 'master'
          }
        ]
      },
      repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
      folderWorkspaces: [],
      detectedWorktreesByRepo: {},
      // The real resolver, bound to this mock state — keeps the folder tests
      // exercising the actual folder-workspace projection.
      getKnownWorktreeById: (worktreeId: string) =>
        findKnownWorktreeById(
          mockState as unknown as Parameters<typeof findKnownWorktreeById>[0],
          worktreeId
        ),
      settings: { experimentalTerminalAttention: true, notifications: { customSoundPath: null } },
      markWorktreeUnread: vi.fn()
    }
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves a folder workspace name for folder: workspace keys', () => {
    mockState.folderWorkspaces = [
      {
        id: 'fw-1',
        projectGroupId: 'group-1',
        name: 'API-792 : Make portal permissions available',
        folderPath: '/home/user/workspaces/api-792'
      }
    ]

    dispatchTerminalNotification('folder:fw-1', {
      source: 'agent-task-complete',
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'review the PR',
        agentType: 'claude',
        stateStartedAt: Date.now()
      }
    })

    expect(getLastNotificationDispatchArg()).toMatchObject({
      worktreeId: 'folder:fw-1',
      worktreeLabel: 'API-792 : Make portal permissions available',
      // Folder workspaces have no repo row; the title is the workspace name alone.
      repoLabel: undefined
    })
  })

  it('falls back to the raw key only when no folder workspace matches it', () => {
    dispatchTerminalNotification('folder:unknown-workspace', {
      source: 'agent-task-complete',
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'review the PR',
        agentType: 'claude',
        stateStartedAt: Date.now()
      }
    })

    expect(getLastNotificationDispatchArg()).toMatchObject({
      worktreeLabel: 'folder:unknown-workspace'
    })
  })
})
