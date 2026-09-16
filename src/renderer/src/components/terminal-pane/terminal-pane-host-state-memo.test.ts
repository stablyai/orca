/**
 * `useShallow` suppresses the render, not the selector: before the memo, every
 * store publication re-resolved the execution host and allocated a fresh 7-key
 * object for every mounted TerminalPane, then threw it away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ConnectionContext from '@/lib/connection-context'
import type { AppState } from '@/store/types'
import {
  resetTerminalPaneHostStateMemoForTests,
  selectTerminalPaneHostState
} from './terminal-pane-host-state'

const connectionIdCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/connection-context', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionContext>()
  return {
    ...actual,
    getConnectionIdFromState: (state: AppState, worktreeId: string | null) => {
      connectionIdCalls.count += 1
      return actual.getConnectionIdFromState(state, worktreeId)
    }
  }
})

const LOCAL_WORKTREE = 'repo-1::/repo/worktrees/local'
const OTHER_WORKTREE = 'repo-2::/repo/worktrees/other'

/** Only the fields the resolver touches; the memo key is the whole object. */
function makeState(overrides: Partial<Record<string, unknown>> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    sshTargetLabels: new Map(),
    removedSshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    sshTargets: [],
    ...overrides
  } as unknown as AppState
}

beforeEach(() => {
  resetTerminalPaneHostStateMemoForTests()
  connectionIdCalls.count = 0
})

describe('selectTerminalPaneHostState memo', () => {
  it('returns the same object across an unrelated store write', () => {
    const first = makeState()
    const before = selectTerminalPaneHostState(first, LOCAL_WORKTREE)

    // A new published state object with no host-relevant change.
    const second = makeState({ rightSidebarOpen: true })
    const after = selectTerminalPaneHostState(second, LOCAL_WORKTREE)

    expect(after).toBe(before)
  })

  it('resolves the host once per published state, not once per mounted tab', () => {
    const state = makeState()
    selectTerminalPaneHostState(state, LOCAL_WORKTREE)
    const afterFirstTab = connectionIdCalls.count
    expect(afterFirstTab).toBe(1)

    // Four more tabs of the same worktree, same publication.
    for (let index = 0; index < 4; index += 1) {
      selectTerminalPaneHostState(state, LOCAL_WORKTREE)
    }
    expect(connectionIdCalls.count).toBe(afterFirstTab)

    // A different worktree in the same publication still resolves.
    selectTerminalPaneHostState(state, OTHER_WORKTREE)
    expect(connectionIdCalls.count).toBe(afterFirstTab + 1)
  })

  it('re-resolves when the published state changes, so a host change is never stale', () => {
    const local = makeState()
    const before = selectTerminalPaneHostState(local, LOCAL_WORKTREE)
    expect(before.sshReconnectTargetId).toBeNull()

    const remote = makeState({
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'ssh-host-a' }],
      worktreesByRepo: {
        'repo-1': [{ id: LOCAL_WORKTREE, repoId: 'repo-1', path: '/repo/worktrees/local' }]
      }
    })
    const after = selectTerminalPaneHostState(remote, LOCAL_WORKTREE)

    expect(after).not.toBe(before)
    expect(after.sshReconnectTargetId).toBe('ssh-host-a')
  })

  it('allocates nothing across 1,000 publications at 6 worktrees x 5 tabs', () => {
    const worktreeIds = Array.from({ length: 6 }, (_, index) => `repo-${index}::/repo/wt-${index}`)
    const firstState = makeState()
    const firstByWorktree = new Map(
      worktreeIds.map((worktreeId) => [
        worktreeId,
        selectTerminalPaneHostState(firstState, worktreeId)
      ])
    )
    connectionIdCalls.count = 0
    let allocations = 0

    for (let publication = 0; publication < 1_000; publication += 1) {
      // One published state object, then every mounted tab's selector run.
      const state = makeState({ agentStatusEpoch: publication })
      for (const worktreeId of worktreeIds) {
        for (let tab = 0; tab < 5; tab += 1) {
          if (selectTerminalPaneHostState(state, worktreeId) !== firstByWorktree.get(worktreeId)) {
            allocations += 1
          }
        }
      }
    }

    expect(allocations).toBe(0)
    // One host resolve per worktree per publication instead of one per tab.
    expect(connectionIdCalls.count).toBe(6 * 1_000)
  })
})
