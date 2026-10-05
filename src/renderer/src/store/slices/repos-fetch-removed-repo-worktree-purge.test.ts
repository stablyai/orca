// A repo removed outside the window leaves through fetchRepos, so its worktrees' tabs, files and
// active selection must be purged there, as they are when a worktree vanishes externally.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore, makeOpenFile, makeTab, makeWorktree } from './store-test-helpers'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'

const keptRepo: Repo = {
  id: 'repo-kept',
  path: '/kept',
  displayName: 'Kept',
  badgeColor: '#000000',
  addedAt: 1,
  executionHostId: 'local'
}
const removedRepo: Repo = { ...keptRepo, id: 'repo-removed', path: '/removed', addedAt: 2 }
const runtimeRepo: Repo = {
  ...keptRepo,
  id: 'repo-runtime',
  path: '/srv/runtime',
  addedAt: 3,
  executionHostId: 'runtime:env-1'
}

const REMOVED_LISTED = 'repo-removed::/removed/wt'
const REMOVED_DETECTED_ONLY = 'repo-removed::/removed/wt-detected'
const KEPT = 'repo-kept::/kept/wt'
const RUNTIME = 'repo-runtime::/srv/runtime/wt'
const UNKNOWN = 'repo-unknown::/unknown/wt'
const ALL_WORKTREE_IDS = [REMOVED_LISTED, REMOVED_DETECTED_ONLY, KEPT, RUNTIME, UNKNOWN]

const tabIdOf = (worktreeId: string): string => `tab:${worktreeId}`
const fileIdOf = (worktreeId: string): string => `file:${worktreeId}`

const reposList = vi.fn()
const ptyKill = vi.fn()

function seededStore(active: { worktreeId: string }): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const wt = (id: string, repoId: string, extra: Partial<Worktree> = {}): Worktree =>
    makeWorktree({ id, repoId, path: id.slice(id.indexOf('::') + 2), ...extra })
  const removedListed = wt(REMOVED_LISTED, removedRepo.id)
  const removedDetectedOnly = wt(REMOVED_DETECTED_ONLY, removedRepo.id)
  const kept = wt(KEPT, keptRepo.id)
  const runtime = wt(RUNTIME, runtimeRepo.id, { hostId: 'runtime:env-1' })
  const unknown = wt(UNKNOWN, 'repo-unknown')
  store.setState({
    repos: [keptRepo, removedRepo, runtimeRepo],
    worktreesByRepo: {
      [removedRepo.id]: [removedListed],
      [keptRepo.id]: [kept],
      [runtimeRepo.id]: [runtime],
      'repo-unknown': [unknown]
    },
    detectedWorktreesByRepo: {
      [removedRepo.id]: makeDetectedResult(removedRepo.id, [removedListed, removedDetectedOnly])
    },
    tabsByWorktree: Object.fromEntries(
      ALL_WORKTREE_IDS.map((id) => [id, [makeTab({ id: tabIdOf(id), worktreeId: id })]])
    ),
    ptyIdsByTabId: Object.fromEntries(ALL_WORKTREE_IDS.map((id) => [tabIdOf(id), [`pty:${id}`]])),
    openFiles: ALL_WORKTREE_IDS.map((id) => makeOpenFile({ id: fileIdOf(id), worktreeId: id })),
    activeWorktreeId: active.worktreeId,
    activeTabId: tabIdOf(active.worktreeId),
    activeFileId: fileIdOf(active.worktreeId),
    workspaceSpaceMeasurements: [REMOVED_LISTED, REMOVED_DETECTED_ONLY, KEPT].map((id) => ({
      worktreeId: id,
      status: 'ok' as const,
      sizeBytes: 1
    }))
  })
  return store
}

function openFileWorktreeIds(store: ReturnType<typeof createTestStore>): string[] {
  return store.getState().openFiles.map((file) => file.worktreeId)
}

beforeEach(() => {
  reposList.mockReset()
  ptyKill.mockReset()
  // Why: the catalog arrives over IPC, so each fetch hands back fresh rows.
  reposList.mockImplementation(async () => [structuredClone(keptRepo)])
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: vi.fn() }
    },
    dispatchEvent: vi.fn()
  })
})

describe('fetchRepos purges worktree state of a repo removed outside the window', () => {
  it('clears the active worktree, its tabs, the active tab and its open files', async () => {
    const store = seededStore({ worktreeId: REMOVED_LISTED })

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(s.activeWorktreeId).toBeNull()
    expect(s.tabsByWorktree).not.toHaveProperty(REMOVED_LISTED)
    expect(s.activeTabId).toBeNull()
    expect(s.activeFileId).toBeNull()
    expect(openFileWorktreeIds(store)).not.toContain(REMOVED_LISTED)
  })

  it('purges a worktree known only from the detected listing', async () => {
    const store = seededStore({ worktreeId: KEPT })

    await store.getState().fetchRepos()

    expect(store.getState().tabsByWorktree).not.toHaveProperty(REMOVED_DETECTED_ONLY)
    expect(openFileWorktreeIds(store)).not.toContain(REMOVED_DETECTED_ONLY)
  })

  it('leaves a surviving repo worktree state and active selection alone', async () => {
    const store = seededStore({ worktreeId: KEPT })
    const keptTabs = store.getState().tabsByWorktree[KEPT]

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(KEPT)
    expect(s.activeTabId).toBe(tabIdOf(KEPT))
    expect(s.activeFileId).toBe(fileIdOf(KEPT))
    expect(s.tabsByWorktree[KEPT]).toBe(keptTabs)
    expect(openFileWorktreeIds(store)).toContain(KEPT)
  })

  it('keeps terminal state of unknown repo ids and of other hosts on a local fetch', async () => {
    const store = seededStore({ worktreeId: KEPT })
    const before = store.getState().tabsByWorktree

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.tabsByWorktree[UNKNOWN]).toBe(before[UNKNOWN])
    expect(s.tabsByWorktree[RUNTIME]).toBe(before[RUNTIME])
    expect(openFileWorktreeIds(store)).toEqual(expect.arrayContaining([UNKNOWN, RUNTIME]))
  })

  it('kills no PTY, matching the external worktree removal path', async () => {
    const store = seededStore({ worktreeId: REMOVED_LISTED })

    await store.getState().fetchRepos()

    // Proves the removal path ran, so the absence of kills is meaningful.
    expect(store.getState().worktreesByRepo).not.toHaveProperty(removedRepo.id)
    expect(ptyKill).not.toHaveBeenCalled()
  })

  it('drops workspace-space measurements of the removed repo worktrees only', async () => {
    const store = seededStore({ worktreeId: KEPT })

    await store.getState().fetchRepos()

    expect(
      store.getState().workspaceSpaceMeasurements.map((measurement) => measurement.worktreeId)
    ).toEqual([KEPT])
  })
})
