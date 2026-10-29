import { describe, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import type { AppState } from '../store/types'
import { buildHostSessionRouting } from './workspace-session-host-persistence'
import { discoverSessionSources } from './test-support/session-source-discovery'
import { SessionRoutingCatalog } from './session-routing-catalog'
import { SessionUnitProjection } from './session-unit-projection'

const owner = 'repo::/a'
const other = 'other::/b'
function fixture(): AppState {
  return {
    ...useAppStore.getState(),
    repos: [
      { ...TEST_REPO, id: 'repo' },
      { ...TEST_REPO, id: 'other' }
    ],
    worktreesByRepo: {
      repo: [makeWorktree({ id: owner, repoId: 'repo', hostId: 'local' })],
      other: [makeWorktree({ id: other, repoId: 'other', hostId: 'local' })]
    },
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    contestedPrimaryHostBySessionKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFiles: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {}
  }
}

describe('keyed routing catalog', () => {
  it('matches full ownership through catalog changes, duplicate claims and restored aliases', () => {
    let state = fixture()
    const catalog = new SessionRoutingCatalog(state)
    const edits: ((state: AppState) => AppState)[] = [
      (state) => ({
        ...state,
        repos: state.repos.map((repo) => (repo.id === 'repo' ? { ...repo, name: 'renamed' } : repo))
      }),
      (state) => ({
        ...state,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          repo: state.worktreesByRepo.repo.map((row) => ({
            ...row,
            runtimeOwnerEnvironmentId: 'env-a'
          }))
        }
      }),
      (state) => ({
        ...state,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          '1': [makeWorktree({ id: owner, repoId: 'repo', runtimeOwnerEnvironmentId: 'env-b' })]
        }
      }),
      (state) => ({
        ...state,
        contestedPrimaryHostBySessionKey: { [`worktree:${owner}`]: 'runtime:env-b' }
      }),
      (state) => ({
        ...state,
        restoredRuntimeHostIdByWorkspaceSessionKey: { [owner]: 'runtime:env-a' }
      }),
      (state) => ({ ...state, worktreesByRepo: { other: state.worktreesByRepo.other } }),
      (state) => ({
        ...state,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          repo: [makeWorktree({ id: owner, repoId: 'repo', hostId: 'local' })]
        }
      })
    ]
    for (const edit of edits) {
      const next = edit(state)
      catalog.update(next, discoverSessionSources(state, next))
      const full = buildHostSessionRouting(next)
      for (const key of [owner, `worktree:${owner}`, other, `worktree:${other}`]) {
        expect(catalog.routing.hostIdByWorktreeId(key)).toBe(full.hostIdByWorktreeId(key))
      }
      for (const key of [owner, other]) {
        expect(catalog.routing.claims.get(key)).toEqual(full.claims.get(key))
      }
      state = next
    }
  })

  it('keeps metadata projection keyed without visiting another workspace bucket', () => {
    const before = fixture()
    const projection = new SessionUnitProjection(before)
    const next = {
      ...before,
      repos: before.repos.map((repo) => (repo.id === 'repo' ? { ...repo, name: 'renamed' } : repo))
    }
    Object.defineProperty(before.worktreesByRepo.other, Symbol.iterator, {
      value: () => {
        throw new Error('unrelated worktree content read')
      }
    })
    const update = projection.update(next, discoverSessionSources(before, next))
    expect(update.full).toBe(false)
    expect(update.workspaces.has(other)).toBe(false)
    expect(update.routing?.hostIdByWorktreeId(owner)).toBe('local')
  })
})
