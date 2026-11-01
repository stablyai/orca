import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  AuthorityRuntime,
  openAuthorityRuntime,
  reveal,
  inWorkspace
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import type { Repo } from '../../src/shared/repo-types'
import type { RuntimeWorktreeScanResult } from '../../src/main/runtime/repo-worktree-resolution-scan'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'
import { StructuredWorkspaceUnavailable } from '../../src/main/runtime/session-tabs/structured-workspace-authority'
import { hostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

/** Each Git owner answers with its own listing; no listing is warm before the open. */
class ListingRuntime extends AuthorityRuntime {
  listings = new Map<string, RuntimeWorktreeScanResult>()
  scans: string[] = []
  protected override async listRepoWorktreesForResolution(repo: Repo) {
    this.scans.push(repo.id)
    return (
      this.listings.get(repo.id) ?? {
        ok: true as const,
        worktrees: [checkout(repo.path, true)]
      }
    )
  }
}

function checkout(path: string, isMainWorktree = false) {
  return { path, head: 'abc', branch: 'refs/heads/topic', isBare: false, isMainWorktree }
}

async function retired(
  sourcePath: string,
  kind: 'folder' | 'git-worktree' = 'git-worktree',
  executionHostId: 'local' | 'ssh:offline' = 'local'
) {
  const input = await inWorkspace(`retired::${sourcePath}`, kind, executionHostId)
  input.profile.removeFolderWorkspace(input.folderId)
  const runtime = new ListingRuntime(input.profile)
  const rig = await openAuthorityRuntime(input, runtime)
  return { ...rig, runtime, location: rig.store.getRecord(B)!.location }
}

it('recovers a linked checkout after restart from its owner listing, scanning each owner once', async () => {
  const rig = await retired(`${root}/topic`)
  rig.profile.addRepo(storeRepo({ id: 'current', path: `${root}/main` }))
  rig.runtime.listings.set('current', {
    ok: true,
    worktrees: [checkout(`${root}/main`, true), checkout(`${root}/topic`)]
  })
  const cached = vi.spyOn(rig.runtime as never, 'projectCachedWorktrees')
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: `current::${root}/topic` }
  })
  expect(rig.store.getRecord(B)?.location).toMatchObject({
    workspaceId: `current::${root}/topic`,
    workspaceKind: 'git-worktree'
  })
  expect(rig.runtime.scans).toEqual(['current'])
  expect(cached).not.toHaveBeenCalled()
})

it.each([
  ['a trailing slash', () => root, () => `${root}/`, () => root],
  [
    'Windows case',
    () => 'C:\\USERS\\me\\repo',
    () => 'C:\\Users\\Me\\Repo',
    () => 'c:\\users\\me\\repo'
  ]
])('counts one registration once despite %s', async (_label, source, registered, listed) => {
  const rig = await retired(source())
  rig.profile.addRepo(storeRepo({ id: 'current', path: registered() }))
  rig.runtime.listings.set('current', { ok: true, worktrees: [checkout(listed(), true)] })
  const prepared = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
  prepared.release()
  // Git's spelling keys the catalog's workspace.
  expect(prepared.location.workspaceId).toBe(`current::${listed()}`)
})

it('refuses distinct registrations at one directory', async () => {
  const rig = await retired(root)
  rig.profile.addRepo(storeRepo({ id: 'one', path: root }))
  rig.profile.addRepo(storeRepo({ id: 'two', path: `${root}/`, kind: 'folder' }))
  await expect(
    rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
  ).rejects.toBeInstanceOf(StructuredWorkspaceUnavailable)
})

it('refuses while any same-host owner listing is unavailable', async () => {
  const rig = await retired(root, 'folder')
  rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
  // An owner whose listing failed could still list this directory.
  rig.profile.addRepo(storeRepo({ id: 'unreachable', path: `${root}-other` }))
  rig.runtime.listings.set('unreachable', { ok: false, worktrees: [] })
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  })
  expect(rig.store.getRecord(B)?.location.workspaceId).toBe(`retired::${root}`)
})

it.each([
  ['a second registration appears', 'late'],
  ['the source registration returns', 'retired']
])('re-derives the destination at commit when %s', async (_label, id) => {
  const rig = await retired(root, 'folder')
  rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
  const rebind = rig.store.rebindWorkspace.bind(rig.store)
  vi.spyOn(rig.store, 'rebindWorkspace').mockImplementationOnce(async (...args) => {
    rig.profile.addRepo(storeRepo({ id, path: root, kind: 'folder' }))
    return rebind(...args)
  })
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  })
  expect(rig.store.getRecord(B)?.location.workspaceId).toBe(`retired::${root}`)
})

it.each([
  // macOS folds /private/tmp into /tmp; a Linux SSH host keeps them apart.
  ['/tmp/chat-folder', null],
  ['/private/tmp/chat-folder', 'current::/private/tmp/chat-folder']
])('compares a remote record with its own host path rules: %s', async (path, expected) => {
  const rig = await retired('/private/tmp/chat-folder', 'folder', 'ssh:offline')
  rig.profile.addRepo(
    storeRepo({ id: 'current', path, kind: 'folder', executionHostId: 'ssh:offline' })
  )
  const prepared = rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
  if (expected === null) {
    await expect(prepared).rejects.toBeInstanceOf(StructuredWorkspaceUnavailable)
  } else {
    const authority = await prepared
    authority.release()
    expect(authority.location.workspaceId).toBe(expected)
  }
})

it('keeps destination discovery linear in repos, folders and metadata rows', async () => {
  const rig = await retired(`${root}/topic`)
  rig.profile.addRepo(storeRepo({ id: 'current', path: `${root}/main` }))
  rig.runtime.listings.set('current', {
    ok: true,
    worktrees: [checkout(`${root}/main`, true), checkout(`${root}/topic`)]
  })
  let reads = 0
  const counted = <T extends object>(rows: readonly T[]) =>
    rows.map(
      (row) =>
        new Proxy(row, {
          get: (target, key, receiver) => {
            reads++
            return Reflect.get(target, key, receiver)
          }
        })
    )
  const store = rig.profile
  const repos = store.getRepos.bind(store)
  const folders = store.getFolderWorkspaces.bind(store)
  const groups = store.getProjectGroups.bind(store)
  let foreign: FolderWorkspace[] = []
  vi.spyOn(store, 'getRepos').mockImplementation(() => counted(repos()))
  vi.spyOn(store, 'getFolderWorkspaces').mockImplementation(() =>
    counted([...folders(), ...foreign])
  )
  vi.spyOn(store, 'getProjectGroups').mockImplementation(() => counted(groups()))
  const counts: { reads: number; scans: number }[] = []
  let added = 0
  for (const population of [20, 200]) {
    for (; added < population; added++) {
      store.addRepo(storeRepo({ id: `owner-${added}`, path: `${root}/repo-${added}` }))
      store.setWorktreeMeta(
        hostWorktreeTarget({ id: `owner-${added}::${root}/repo-${added}/linked`, hostId: 'local' }),
        {}
      )
    }
    // Same-directory folders on other hosts must each be rejected without a catalog-wide lookup.
    foreign = Array.from({ length: population }, (_, i) => ({
      id: `foreign-${i}`,
      projectGroupId: `group-${i}`,
      executionHostId: `ssh:elsewhere-${i}`,
      name: 'Elsewhere',
      folderPath: `${root}/topic`,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }))
    reads = 0
    rig.runtime.scans = []
    const prepared = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
    prepared.admit()
    prepared.release()
    expect(prepared.location.workspaceId).toBe(`current::${root}/topic`)
    counts.push({ reads, scans: rig.runtime.scans.length })
  }
  expect(counts[1].scans).toBe(counts[0].scans + 180)
  expect(counts[1].reads).toBeLessThanOrEqual(12 * counts[0].reads)
})
