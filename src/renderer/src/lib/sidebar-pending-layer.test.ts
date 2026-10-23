import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { buildWorkspaceRows, type WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import type { PairedServerWorkspaceRow } from '../../../shared/sidebar-list/paired-server-rows'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  makeFolderWorkspace,
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump-palette-test-fixtures'
import type { DesktopSidebarFeed } from './desktop-sidebar-feed'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
const feed = vi.hoisted(() => ({
  lastReadId: 0,
  installListeners: new Set<(installed: DesktopSidebarFeed) => void>()
}))
vi.mock('./desktop-sidebar-feed', () => ({
  refreshDesktopSidebarFeed: () => ++feed.lastReadId,
  onDesktopSidebarFeedInstalled: (listener: (installed: DesktopSidebarFeed) => void) => {
    feed.installListeners.add(listener)
    return () => feed.installListeners.delete(listener)
  }
}))

const repo = makeRepo()
const local = makeWorktree('repo-1::/w/a', 'a', { hostId: 'local', manualOrder: 1 })
const CATALOG = { repos: [repo], lineageById: {} }

function domains(
  rows: WorkspaceRow[],
  serverRows: PairedServerWorkspaceRow[] = []
): SidebarFeedDomains {
  return {
    workspaces: new Map(
      rows.map((row) => [
        composeWorktreeHostIdentity(parseExecutionHostId(row.hostId)?.id, row.id),
        row
      ])
    ),
    activity: new Map(),
    review: new Map(),
    creations: new Map(),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(serverRows.map((row) => [row.key, row])),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null
  }
}

function rowOf(worktree = local): WorkspaceRow {
  return [
    ...buildWorkspaceRows({ ...CATALOG, worktrees: [worktree], folderWorkspaces: [] }).values()
  ][0]!
}

function serverRow(manualOrder: number): PairedServerWorkspaceRow {
  return {
    key: 'runtime:env-1|api::/w/x',
    worktreeId: 'api::/w/x',
    repoId: 'api',
    kind: 'git',
    path: '/w/x',
    branch: 'x',
    displayName: 'x',
    isArchived: false,
    isPinned: false,
    manualOrder
  }
}

function install(installed: SidebarFeedDomains, readId = feed.lastReadId): void {
  feed.installListeners.forEach((listener) => listener({ domains: installed, readId }))
}

async function load() {
  vi.resetModules()
  return import('./sidebar-pending-layer')
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('sidebar pending layer', () => {
  beforeEach(() => {
    feed.lastReadId = 0
    feed.installListeners.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lays a row write over main from its start until a read sent after main answered', async () => {
    const layer = await load()
    const main = domains([rowOf()])
    const write = deferred()
    const running = layer.withPendingSidebarRowWrites(
      () => [{ worktreeId: local.id, updates: { manualOrder: 9 }, executionHostId: 'local' }],
      () => write.promise
    )
    const overlaid = () =>
      layer.overlaySidebarPendingLayer(main, layer.readSidebarPendingLayer(), CATALOG)
    expect([...overlaid().workspaces.values()][0]?.manualOrder).toBe(9)
    // A read from before the answer reflects main without the write.
    install(main, 0)
    expect([...overlaid().workspaces.values()][0]?.manualOrder).toBe(9)
    write.resolve()
    await running
    expect(feed.lastReadId).toBe(1)
    // Main's value wins once a later read installs, here as if main had refused the write.
    install(main, 1)
    expect(layer.readSidebarPendingLayer().writes).toEqual([])
    expect(overlaid()).toBe(main)
  })

  it('holds a paired server row write until main’s row echoes it, at most ten seconds', async () => {
    vi.useFakeTimers()
    const layer = await load()
    await layer.withPendingSidebarRowWrites(
      () => [
        { worktreeId: 'api::/w/x', updates: { manualOrder: 5 }, executionHostId: 'runtime:env-1' }
      ],
      async () => {}
    )
    await Promise.resolve()
    // Answered and read, but the server's event has not reached main yet.
    install(domains([], [serverRow(1)]))
    const shown = () =>
      [
        ...layer
          .overlaySidebarPendingLayer(
            domains([], [serverRow(1)]),
            layer.readSidebarPendingLayer(),
            CATALOG
          )
          .pairedServerRows.values()
      ][0]?.manualOrder
    expect(shown()).toBe(5)
    install(domains([], [serverRow(5)]))
    expect(layer.readSidebarPendingLayer().writes).toEqual([])

    await layer.withPendingSidebarRowWrites(
      () => [
        { worktreeId: 'api::/w/x', updates: { manualOrder: 7 }, executionHostId: 'runtime:env-1' }
      ],
      async () => {}
    )
    await Promise.resolve()
    install(domains([], [serverRow(5)]))
    expect(shown()).toBe(7)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.advanceTimersByTime(10_000)
    expect(warn).toHaveBeenCalledOnce()
    expect(shown()).toBe(1)
  })

  it('lists a created workspace until main lists it', async () => {
    const layer = await load()
    const created = makeWorktree('repo-1::/w/new', 'new', { hostId: 'local' })
    layer.holdCreatedSidebarWorkspace({ worktree: created })
    const ids = (main: SidebarFeedDomains) =>
      [
        ...layer
          .overlaySidebarPendingLayer(main, layer.readSidebarPendingLayer(), CATALOG)
          .workspaces.values()
      ].map((row) => row.id)
    expect(ids(domains([rowOf()]))).toEqual([local.id, created.id])
    install(domains([rowOf()]))
    expect(ids(domains([rowOf()]))).toEqual([local.id, created.id])
    install(domains([rowOf(), rowOf(created)]))
    expect(layer.readSidebarPendingLayer().created).toEqual([])
  })

  it('lists a workspace created on a paired server until main lists the server’s row', async () => {
    const layer = await load()
    const worktree = makeWorktree('api::/w/new', 'new', { hostId: 'runtime:env-1' })
    const folder = makeFolderWorkspace({ executionHostId: 'runtime:env-1', name: 'Notes' })
    layer.holdCreatedSidebarWorkspace({ worktree })
    layer.holdCreatedSidebarWorkspace({ folderWorkspace: folder })
    const keys = (main: SidebarFeedDomains) => [
      ...layer
        .overlaySidebarPendingLayer(main, layer.readSidebarPendingLayer(), CATALOG)
        .pairedServerRows.keys()
    ]
    // Main answered the create, but the server's list has not reached it yet.
    install(domains([]))
    expect(keys(domains([]))).toEqual([
      'runtime:env-1|api::/w/new',
      'runtime:env-1|folder:folder-1'
    ])
    expect(
      layer
        .overlaySidebarPendingLayer(domains([]), layer.readSidebarPendingLayer(), CATALOG)
        .pairedServerRows.get('runtime:env-1|folder:folder-1')
    ).toMatchObject({ kind: 'folder', displayName: 'Notes' })
    const listed = layer.overlaySidebarPendingLayer(
      domains([]),
      layer.readSidebarPendingLayer(),
      CATALOG
    ).pairedServerRows
    install(domains([], [...listed.values()]))
    expect(layer.readSidebarPendingLayer().created).toEqual([])
  })

  it('lets a newer write to the same paired server row win over an older one', async () => {
    const layer = await load()
    const write = (manualOrder: number) =>
      layer.withPendingSidebarRowWrites(
        () => [
          { worktreeId: 'api::/w/x', updates: { manualOrder }, executionHostId: 'runtime:env-1' }
        ],
        async () => {}
      )
    await write(5)
    await write(7)
    await Promise.resolve()
    // Main shows the newer value: nothing older is left to paint over it.
    install(domains([], [serverRow(7)]))
    expect(layer.readSidebarPendingLayer().writes).toEqual([])
  })

  it('leaves a write with no row field to main alone', async () => {
    const layer = await load()
    await layer.withPendingSidebarRowWrites(
      () => [{ worktreeId: local.id, updates: { comment: 'note' } }],
      async () => {}
    )
    expect(layer.readSidebarPendingLayer()).toEqual({ writes: [], created: [] })
    expect(feed.lastReadId).toBe(0)
  })
})
