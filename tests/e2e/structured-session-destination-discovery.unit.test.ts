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
import type { ProjectGroup } from '../../src/shared/project-group-types'
import type { Project } from '../../src/shared/project-types'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../../src/main/wsl'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

/** Each Git owner answers with its own listing; no listing is warm before the open. Only the
 *  catalog's scan I/O is replaced, so its cache, freshness and in-flight rules stay real. */
class ListingRuntime extends AuthorityRuntime {
  listings = new Map<string, RuntimeWorktreeScanResult>()
  scans: string[] = []
  protected override async refreshRepoWorktreeScan(repo: Repo) {
    this.scans.push(repo.id)
    return {
      result: this.listings.get(repo.id) ?? {
        ok: true as const,
        worktrees: [checkout(repo.path, true)]
      },
      adminFingerprint: null,
      adminFingerprintProbe: null,
      scannedAt: Date.now()
    }
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
  [
    'a second registration appears',
    'late',
    { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  ],
  // Preparing again finds the source registered: the chat opens where it already is.
  ['the source registration returns', 'retired', { ok: true, workspaceId: 'retired::' }]
])('re-derives the destination at commit when %s', async (_label, id, result) => {
  const rig = await retired(root, 'folder')
  rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
  const rebind = rig.store.rebindWorkspace.bind(rig.store)
  vi.spyOn(rig.store, 'rebindWorkspace').mockImplementationOnce(async (...args) => {
    rig.profile.addRepo(storeRepo({ id, path: root, kind: 'folder' }))
    return rebind(...args)
  })
  const opened = 'workspaceId' in result ? { ...result, workspaceId: `retired::${root}` } : result
  expect(await reveal(rig)).toMatchObject({ ok: true, result: opened })
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

const folderRow = (id: string, extra: Partial<FolderWorkspace>): FolderWorkspace => ({
  id,
  projectGroupId: `group-${id}`,
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
  updatedAt: 0,
  ...extra
})

/** Every read of a catalog row counts, including reads inside the shared host resolver. The
 *  extra rows reach discovery only through the store's catalog reads. */
function countCatalogReads(rig: Awaited<ReturnType<typeof retired>>) {
  const counter = {
    reads: 0,
    repos: [] as Repo[],
    folders: [] as FolderWorkspace[],
    groups: [] as ProjectGroup[]
  }
  // Every read of a catalog row's own fields counts.
  const counted = <T extends object>(rows: readonly T[]): T[] =>
    rows.map((row) => {
      const copy = { ...row }
      for (const [key, value] of Object.entries(row)) {
        Object.defineProperty(copy, key, {
          enumerable: true,
          get: () => {
            counter.reads++
            return value
          }
        })
      }
      return copy
    })
  const store = rig.profile
  const repos = store.getRepos.bind(store)
  const folders = store.getFolderWorkspaces.bind(store)
  const groups = store.getProjectGroups.bind(store)
  vi.spyOn(store, 'getRepos').mockImplementation(() => counted([...repos(), ...counter.repos]))
  vi.spyOn(store, 'getFolderWorkspaces').mockImplementation(() =>
    counted([...folders(), ...counter.folders])
  )
  vi.spyOn(store, 'getProjectGroups').mockImplementation(() =>
    counted([...groups(), ...counter.groups])
  )
  return counter
}

const groupRow = (id: string, extra: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name: id,
  parentPath: root,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra
})

it('keeps destination discovery linear in repos, folders, groups and metadata rows', async () => {
  const rig = await retired(`${root}/topic`)
  rig.profile.addRepo(storeRepo({ id: 'current', path: `${root}/main` }))
  rig.runtime.listings.set('current', {
    ok: true,
    worktrees: [checkout(`${root}/main`, true), checkout(`${root}/topic`)]
  })
  const counter = countCatalogReads(rig)
  const store = rig.profile
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
    // Same-directory folders on other hosts, pinned on the row or through their group, are
    // supported and must each be rejected without a catalog-wide lookup.
    counter.folders = Array.from({ length: population }, (_, i) => [
      folderRow(`pinned-${i}`, { executionHostId: `ssh:elsewhere-${i}` }),
      folderRow(`grouped-${i}`, {})
    ]).flat()
    counter.groups = Array.from({ length: population }, (_, i) =>
      groupRow(`group-grouped-${i}`, {
        parentPath: `${root}/elsewhere-${i}`,
        executionHostId: `ssh:elsewhere-${i}`
      })
    )
    counter.reads = 0
    rig.runtime.scans = []
    const prepared = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
    prepared.admit()
    prepared.release()
    expect(prepared.location.workspaceId).toBe(`current::${root}/topic`)
    counts.push({ reads: counter.reads, scans: rig.runtime.scans.length })
  }
  // Fresh listings are reused across opens; only owners new since the first open are scanned.
  expect(counts.map((count) => count.scans)).toEqual([21, 180])
  expect(counts[1].reads).toBeLessThanOrEqual(12 * counts[0].reads)
})

// Same-directory scopes whose host takes reading more than the row: N folders each in its own group.
const sameDirectoryScopes: [
  string,
  (n: number) => Partial<ReturnType<typeof countCatalogReads>>
][] = [
  [
    'a chain of nested groups pinned to another host',
    (n) => ({
      folders: Array.from({ length: n }, (_, i) =>
        folderRow(`nested-${i}`, { projectGroupId: `chain-${i}`, folderPath: root })
      ),
      groups: Array.from({ length: n }, (_, i) =>
        groupRow(`chain-${i}`, {
          parentGroupId: i ? `chain-${i - 1}` : null,
          executionHostId: 'ssh:foreign'
        })
      )
    })
  ],
  [
    'unpinned groups whose own repos are on another host',
    (n) => ({
      folders: Array.from({ length: n }, (_, i) =>
        folderRow(`legacy-${i}`, { projectGroupId: `legacy-${i}`, folderPath: root })
      ),
      groups: Array.from({ length: n }, (_, i) => groupRow(`legacy-${i}`)),
      repos: Array.from({ length: n }, (_, i) =>
        storeRepo({
          id: `legacy-repo-${i}`,
          path: `${root}/sub-${i}`,
          projectGroupId: `legacy-${i}`,
          executionHostId: 'ssh:foreign'
        })
      )
    })
  ],
  [
    'spellings of the directory over repos on another host',
    (n) => ({
      folders: Array.from({ length: n }, (_, i) =>
        folderRow(`alias-${i}`, {
          projectGroupId: `alias-${i}`,
          folderPath: root + '/'.repeat(i + 1)
        })
      ),
      groups: Array.from({ length: n }, (_, i) => groupRow(`alias-${i}`)),
      repos: Array.from({ length: n }, (_, i) =>
        storeRepo({
          id: `alias-repo-${i}`,
          path: `${root}/sub-${i}`,
          executionHostId: 'ssh:foreign'
        })
      )
    })
  ],
  [
    'a ring of unpinned groups, each holding a repo on another host',
    (n) => ({
      folders: Array.from({ length: n }, (_, i) =>
        folderRow(`ring-folder-${i}`, { projectGroupId: `ring-${i}`, folderPath: root })
      ),
      groups: Array.from({ length: n }, (_, i) =>
        groupRow(`ring-${i}`, { parentGroupId: `ring-${(i + 1) % n}` })
      ),
      repos: Array.from({ length: n }, (_, i) =>
        storeRepo({
          id: `ring-repo-${i}`,
          path: `/elsewhere/${i}`,
          projectGroupId: `ring-${i}`,
          executionHostId: 'ssh:foreign'
        })
      )
    })
  ]
]

it.each(sameDirectoryScopes)(
  'resolves %s once per pass, at preparation and at commit, at N and 10N',
  async (_label, scopes) => {
    const rig = await retired(root, 'folder')
    rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
    const counter = countCatalogReads(rig)
    // Group lookups inside the index count too: a ring must not be walked once per member.
    const get = Map.prototype.get
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key) {
      if (typeof key === 'string' && key.startsWith('ring-')) {
        counter.reads++
      }
      return get.call(this, key)
    })
    const counts: { prepare: number; admit: number }[] = []
    for (const n of [20, 200]) {
      Object.assign(counter, { repos: [], folders: [], groups: [] }, scopes(n))
      counter.reads = 0
      const prepared = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
      const prepare = counter.reads
      counter.reads = 0
      prepared.admit()
      prepared.release()
      // Every scope is on another host, so the one registration remains the destination.
      expect(prepared.location.workspaceId).toBe(`current::${root}`)
      counts.push({ prepare, admit: counter.reads })
    }
    expect(counts[1].prepare).toBeLessThanOrEqual(12 * counts[0].prepare)
    expect(counts[1].admit).toBeLessThanOrEqual(12 * counts[0].admit)
  }
)

it('refuses many rival registrations at the directory without locating each one, at N and 10N', async () => {
  const rig = await retired(root, 'folder')
  const counter = countCatalogReads(rig)
  const counts: number[] = []
  for (const n of [40, 400]) {
    counter.repos = Array.from({ length: n }, (_, i) =>
      storeRepo({ id: `rival-${i}`, path: root, kind: 'folder' })
    )
    counter.reads = 0
    await expect(
      rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
    ).rejects.toMatchObject({ reason: 'unknown' })
    counts.push(counter.reads)
  }
  expect(counts[1]).toBeLessThanOrEqual(12 * counts[0])
})

function withWindowsProjects(rig: Awaited<ReturnType<typeof retired>>, projects: Project[]) {
  vi.spyOn(rig.profile, 'getProjects').mockReturnValue(projects)
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  return () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    _resetWslCachesForTests()
  }
}

it('a stopped owner in another distro does not block a native chat; an owner whose runtime is unresolved does', async () => {
  const rig = await retired(root, 'folder')
  rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
  rig.profile.addRepo(storeRepo({ id: 'ubuntu-owner', path: `${root}-other` }))
  // A stopped distro answers a cold listing with a failure.
  rig.runtime.listings.set('ubuntu-owner', { ok: false, worktrees: [] })
  const restore = withWindowsProjects(rig, [
    {
      id: 'ubuntu-project',
      displayName: 'Ubuntu project',
      badgeColor: '#000',
      sourceRepoIds: ['ubuntu-owner'],
      createdAt: 0,
      updatedAt: 0,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    }
  ])
  try {
    const prepared = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
    prepared.admit()
    prepared.release()
    expect(prepared.location.workspaceId).toBe(`current::${root}`)
    expect(rig.runtime.scans).not.toContain('ubuntu-owner')
    // With Ubuntu missing the owner's runtime is unresolved, so it could still list this directory.
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    await expect(
      rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
    ).rejects.toBeInstanceOf(StructuredWorkspaceUnavailable)
    expect(rig.runtime.scans).toContain('ubuntu-owner')
  } finally {
    restore()
  }
})

async function withListedOwner() {
  const rig = await retired(root, 'folder')
  rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
  rig.profile.addRepo(storeRepo({ id: 'other', path: `${root}-other` }))
  const owner = rig.profile.getRepos().find((repo) => repo.id === 'other')!
  // Past the catalog's listing lifetime, without any invalidation event.
  const later = () => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
  return { ...rig, owner, later }
}

it.each([
  ['a refreshed listing shows a competing checkout', true],
  ['a refreshed listing is unchanged', false]
])('commit reads the catalog as it is when %s', async (_label, competitor) => {
  const rig = await withListedOwner()
  const prepared = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(rig.location)
  rig.later()
  rig.runtime.listings.set('other', {
    ok: true,
    worktrees: [checkout(`${root}-other`, true), ...(competitor ? [checkout(root)] : [])]
  })
  // An ordinary catalog read replaces the expired entry.
  await rig.runtime['listRepoWorktreesForResolution'](rig.owner)
  if (competitor) {
    expect(() => prepared.admit()).toThrow(StructuredWorkspaceUnavailable)
  } else {
    expect(() => prepared.admit()).not.toThrow()
  }
  prepared.release()
})

it('a listing that expires before commit is prepared again, then the chat moves', async () => {
  const rig = await withListedOwner()
  const rebind = rig.store.rebindWorkspace.bind(rig.store)
  vi.spyOn(rig.store, 'rebindWorkspace').mockImplementationOnce(async (...args) => {
    rig.later()
    return rebind(...args)
  })
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: `current::${root}` }
  })
  expect(rig.runtime.scans.filter((id) => id === 'other')).toHaveLength(2)
})
