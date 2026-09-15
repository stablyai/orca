import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { AppState } from '../../src/renderer/src/store/types'
import { getRemovedWorktreeIdsAfterAuthoritativeScan } from '../../src/renderer/src/store/slices/worktrees/listing/worktree-host-ownership'
import { mergeWorktree } from '../../src/main/ipc/worktree-metadata-merge'
import { createFolderWorktree } from '../../src/main/repo-worktrees'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStore,
  makeRepo,
  makeTerminalTab,
  testState
} from '../../src/main/persistence-test-harness'
import { buildDetectedGitWorktrees } from '../../src/main/ipc/worktrees/listing/ssh-worktree-fallback'
import { resolveRepoWorktreeRows } from '../../src/main/runtime/repo-worktree-row-resolution'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-folder-upgrade-store-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

it('retains the folder instance and metadata through upgrade, listing, and Store reload', async () => {
  const store = createStore()
  const owner = makeRepo({ id: 'folder', path: 'C:\\projects\\draft', kind: 'folder' })
  store.addRepo(owner)
  const id = `folder::${owner.path}`
  const before = store.setWorktreeMetaForHost(id, 'local', { comment: 'ongoing OMP work' })
  store.setWorktreeMetaForHost(id, 'ssh:builder', { comment: 'other host' })
  store.setWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeRepoId: owner.id,
    activeWorktreeId: id,
    activeTabId: 'omp-tab',
    tabsByWorktree: { [id]: [makeTerminalTab({ id: 'omp-tab', worktreeId: id })] }
  })
  store.updateRepo(owner.id, { kind: 'git', folderUpgradeGitRootPath: 'C:/projects/draft' })
  store.flush()
  const reloaded = createStore()
  const repo = reloaded.getRepo(owner.id)
  expect(repo?.folderUpgradeGitRootPath).toBe('C:/projects/draft')

  if (!repo) {
    throw new Error('registered repo missing')
  }

  const worktrees = [
    { path: 'C:/projects/draft', branch: 'main', head: 'abc', isMainWorktree: true, isBare: false }
  ]

  const detected = buildDetectedGitWorktrees(reloaded, repo, worktrees)

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The purge reader only reads these catalog fields when session hydration is complete.
  const state = {
    repos: [owner],
    worktreesByRepo: { [owner.id]: [mergeWorktree(owner.id, createFolderWorktree(owner), before)] },
    detectedWorktreesByRepo: {},
    hasHydratedWorktreePurge: true
  } as unknown as AppState

  expect(
    getRemovedWorktreeIdsAfterAuthoritativeScan(
      state,
      owner.id,
      { repoId: owner.id, authoritative: true, source: 'git', worktrees: detected },
      'local'
    )
  ).toEqual([])
  expect(reloaded.getWorkspaceSession()).toMatchObject({
    activeWorktreeId: id,
    activeTabId: 'omp-tab',
    tabsByWorktree: { [id]: [{ id: 'omp-tab', worktreeId: id }] }
  })

  const runtime = await resolveRepoWorktreeRows(
    {
      store: reloaded,
      scanRepo: async () => ({ ok: true, worktrees }),
      listFolderWorkspaces: () => []
    },
    repo,
    reloaded.getAllWorktreeMeta(),
    new Map()
  )

  for (const rows of [detected, runtime]) {
    expect(rows[0]).toMatchObject({
      id,
      instanceId: before.instanceId,
      comment: 'ongoing OMP work',
      hostId: 'local'
    })
  }

  expect(reloaded.getWorktreeMetaForHost(id, 'ssh:builder')?.comment).toBe('other host')
  reloaded.flush()
  expect(createStore().getWorktreeMetaForHost(id, 'local')?.instanceId).toBe(before.instanceId)
})

it('drops upgrade path evidence when execution ownership changes', () => {
  const store = createStore()
  store.addRepo(makeRepo({ id: 'folder', path: 'C:\\projects\\draft', kind: 'git' }))
  store.updateRepo('folder', { folderUpgradeGitRootPath: 'C:/projects/draft' })
  store.updateRepo('folder', { executionHostId: 'ssh:builder' })
  expect(store.getRepo('folder')?.folderUpgradeGitRootPath).toBeUndefined()
})
