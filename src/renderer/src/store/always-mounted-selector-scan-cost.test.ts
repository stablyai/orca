/**
 * Zustand reruns every subscriber's selector on every store write, so an O(N)
 * scan inside an always-mounted selector is paid thousands of times per second
 * while the app is idle. These tests count property reads on the store rows to
 * prove each selector builds its index once per snapshot instead of per read.
 */
import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'
import { getLocalPreflightContext } from '../lib/local-preflight-context'
import { getProjectRuntimeSessionSummary } from '../components/settings/repository-runtime-session-summary'
import type { AppState } from './types'
import { selectRepoByIdForActiveWorkspace } from './selectors'

// The user scale that motivated this: 10 repos, 423 worktrees, 382 open tabs.
const REPO_COUNT = 10
const WORKTREES_PER_REPO = 42
const TABS_PER_WORKTREE = 1
const STORE_WRITES = 200

type ReadCounter = { count: number }

function makeRepoRows(counter: ReadCounter): Repo[] {
  return Array.from({ length: REPO_COUNT }, (_unused, index) => {
    const id = `repo-${index}`
    return {
      get id() {
        counter.count += 1
        return id
      },
      path: `/tmp/repo-${index}`,
      displayName: `repo-${index}`,
      badgeColor: '#737373',
      addedAt: 100,
      kind: 'git'
    } as Repo
  })
}

function makeWorktreesByRepo(counter: ReadCounter): AppState['worktreesByRepo'] {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (let repoIndex = 0; repoIndex < REPO_COUNT; repoIndex += 1) {
    const repoId = `repo-${repoIndex}`
    worktreesByRepo[repoId] = Array.from({ length: WORKTREES_PER_REPO }, (_unused, index) => {
      const path = String.raw`\\wsl.localhost\Ubuntu\home\alice\wt-${repoIndex}-${index}`
      const id = `${repoId}${WORKTREE_ID_SEPARATOR}${path}`
      return {
        get id() {
          counter.count += 1
          return id
        },
        repoId,
        path
      } as Worktree
    })
  }
  return worktreesByRepo
}

/** The worst case for a first-wins linear scan: the last row of the last repo. */
function lastWorktreeId(worktreesByRepo: AppState['worktreesByRepo']): string {
  const lastBucket = Object.values(worktreesByRepo).at(-1) ?? []
  return (lastBucket.at(-1) as Worktree).id
}

describe('local preflight context worktree lookup', () => {
  it('builds the worktree index once instead of rescanning per store write', () => {
    const worktreeReads: ReadCounter = { count: 0 }
    const repoReads: ReadCounter = { count: 0 }
    const worktreesByRepo = makeWorktreesByRepo(worktreeReads)
    const activeWorktreeId = lastWorktreeId(worktreesByRepo)
    const state = {
      activeRepoId: `repo-${REPO_COUNT - 1}`,
      activeWorktreeId,
      repos: makeRepoRows(repoReads),
      worktreesByRepo,
      projects: []
    } as unknown as AppState
    const rowCount = REPO_COUNT * WORKTREES_PER_REPO
    worktreeReads.count = 0
    repoReads.count = 0

    for (let write = 0; write < STORE_WRITES; write += 1) {
      expect(getLocalPreflightContext(state, 'darwin')).toEqual({
        wslDistro: 'Ubuntu'
      })
    }

    // One index build per snapshot, not one scan per store write.
    expect(worktreeReads.count).toBeLessThanOrEqual(rowCount)
    expect(repoReads.count).toBeLessThanOrEqual(REPO_COUNT)
  })

  it('rebuilds against a replacement snapshot', () => {
    const counter: ReadCounter = { count: 0 }
    const worktreesByRepo = makeWorktreesByRepo(counter)
    const repos = makeRepoRows({ count: 0 })
    const activeWorktreeId = lastWorktreeId(worktreesByRepo)
    const before = getLocalPreflightContext(
      {
        activeRepoId: 'repo-0',
        activeWorktreeId,
        repos,
        worktreesByRepo
      } as unknown as AppState,
      'darwin'
    )
    expect(before).toEqual({ wslDistro: 'Ubuntu' })

    const movedWorktree = {
      id: activeWorktreeId,
      repoId: `repo-${REPO_COUNT - 1}`,
      path: String.raw`\\wsl.localhost\Debian\home\alice\moved`
    } as Worktree
    const after = getLocalPreflightContext(
      {
        activeRepoId: 'repo-0',
        activeWorktreeId,
        repos,
        worktreesByRepo: { [`repo-${REPO_COUNT - 1}`]: [movedWorktree] }
      } as unknown as AppState,
      'darwin'
    )

    expect(after).toEqual({ wslDistro: 'Debian' })
  })
})

describe('selectRepoByIdForActiveWorkspace', () => {
  function makeActiveWorkspaceState(counter: ReadCounter): AppState {
    return {
      repos: makeRepoRows(counter),
      activeRepoId: 'repo-0',
      // No repo row carries this host, so the fallback branch runs every time.
      activeWorkspaceExecutionHostId: 'ssh:host-a'
    } as unknown as AppState
  }

  it('resolves the active-workspace host once per repos snapshot', () => {
    const counter: ReadCounter = { count: 0 }
    const state = makeActiveWorkspaceState(counter)
    counter.count = 0

    for (let write = 0; write < STORE_WRITES; write += 1) {
      expect(selectRepoByIdForActiveWorkspace(state, 'repo-0')).toBeNull()
    }

    // Worst case: the id-keyed map build plus one host-filter pass.
    expect(counter.count).toBeLessThanOrEqual(REPO_COUNT * 3)
  })

  it('still prefers the row that carries the active workspace host', () => {
    const localRepo = {
      id: 'repo-0',
      path: '/tmp/a',
      displayName: 'a'
    } as Repo
    const sshRepo = {
      id: 'repo-0',
      path: '/tmp/a',
      displayName: 'a',
      connectionId: 'host-a'
    } as Repo
    const state = {
      repos: [localRepo, sshRepo],
      activeRepoId: 'repo-0',
      activeWorkspaceExecutionHostId: 'ssh:host-a'
    } as unknown as AppState

    expect(selectRepoByIdForActiveWorkspace(state, 'repo-0')).toBe(sshRepo)
    expect(selectRepoByIdForActiveWorkspace(state, 'repo-0')).toBe(sshRepo)
  })

  it('returns an identical result for repeated reads of one snapshot', () => {
    const state = makeActiveWorkspaceState({ count: 0 })
    expect(selectRepoByIdForActiveWorkspace(state, 'repo-0')).toBe(
      selectRepoByIdForActiveWorkspace(state, 'repo-0')
    )
    expect(selectRepoByIdForActiveWorkspace(state, 'repo-1')).toBe(
      selectRepoByIdForActiveWorkspace(state, 'repo-1')
    )
  })
})

describe('project runtime session summary', () => {
  function makeRuntimeSessionState(counter: ReadCounter): AppState {
    const tabsByWorktree: Record<string, TerminalTab[]> = {}
    for (let repoIndex = 0; repoIndex < REPO_COUNT; repoIndex += 1) {
      for (let index = 0; index < WORKTREES_PER_REPO; index += 1) {
        const worktreeId = `repo-${repoIndex}${WORKTREE_ID_SEPARATOR}/tmp/wt-${repoIndex}-${index}`
        tabsByWorktree[worktreeId] = Array.from(
          { length: TABS_PER_WORKTREE },
          (_unused, tabIndex) => {
            const id = `tab-${repoIndex}-${index}-${tabIndex}`
            return {
              get id() {
                counter.count += 1
                return id
              },
              ptyId: `pty-${id}`,
              worktreeId
            } as TerminalTab
          }
        )
      }
    }
    return {
      tabsByWorktree,
      ptyIdsByTabId: {},
      agentStatusByPaneKey: {}
    } as unknown as AppState
  }

  it('reuses the tab index across repos and store writes', () => {
    const counter: ReadCounter = { count: 0 }
    const state = makeRuntimeSessionState(counter)
    const tabCount = REPO_COUNT * WORKTREES_PER_REPO * TABS_PER_WORKTREE
    counter.count = 0

    // One RepositoryPane per project, all re-running on every store write.
    for (let write = 0; write < STORE_WRITES; write += 1) {
      for (let repoIndex = 0; repoIndex < REPO_COUNT; repoIndex += 1) {
        expect(getProjectRuntimeSessionSummary(state, `repo-${repoIndex}`)).toEqual({
          liveTerminalCount: WORKTREES_PER_REPO * TABS_PER_WORKTREE,
          activeTaskCount: 0
        })
      }
    }

    // The shared tab index plus one pass over each repo's own tabs.
    expect(counter.count).toBeLessThanOrEqual(tabCount * 3)
  })

  it('returns an identical summary for repeated reads of one snapshot', () => {
    const state = makeRuntimeSessionState({ count: 0 })
    expect(getProjectRuntimeSessionSummary(state, 'repo-0')).toBe(
      getProjectRuntimeSessionSummary(state, 'repo-0')
    )
  })

  it('recomputes when a tab slice is replaced', () => {
    const state = makeRuntimeSessionState({ count: 0 })
    const first = getProjectRuntimeSessionSummary(state, 'repo-0')
    const worktreeId = `repo-0${WORKTREE_ID_SEPARATOR}/tmp/wt-0-0`
    const next = getProjectRuntimeSessionSummary(
      {
        ...state,
        tabsByWorktree: {
          [worktreeId]: [{ id: 'tab-new', ptyId: 'pty-new', worktreeId } as TerminalTab]
        }
      } as unknown as AppState,
      'repo-0'
    )

    expect(first.liveTerminalCount).toBe(WORKTREES_PER_REPO * TABS_PER_WORKTREE)
    expect(next.liveTerminalCount).toBe(1)
  })

  it('counts running agents against the owning project only', () => {
    const state = makeRuntimeSessionState({ count: 0 })
    const summary = getProjectRuntimeSessionSummary(
      {
        ...state,
        agentStatusByPaneKey: {
          'tab-0-0-0:leaf': { state: 'working', tabId: 'tab-0-0-0' },
          'tab-1-0-0:leaf': { state: 'working', tabId: 'tab-1-0-0' },
          'tab-0-1-0:leaf': { state: 'done', tabId: 'tab-0-1-0' }
        }
      } as unknown as AppState,
      'repo-0'
    )

    expect(summary.activeTaskCount).toBe(1)
  })
})
