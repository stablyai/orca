import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarFeedDomains } from '../../../../../shared/sidebar-list/sidebar-feed-domains'
import '../../../../../shared/sidebar-list/workspace-rows'
import type { WorkspaceRow } from '../../../../../shared/sidebar-list/workspace-rows'
import type { PairedServerWorkspaceRow } from '../../../../../shared/sidebar-list/paired-server-rows'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import {
  makeFolderWorkspace,
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import type { DesktopSidebarFeed } from './desktop-sidebar-feed'

vi.mock('../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))
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
makeWorktree('repo-1::/w/a', 'a', { hostId: 'local', manualOrder: 1 })
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

function install(installed: SidebarFeedDomains, readId = feed.lastReadId): void {
  feed.installListeners.forEach((listener) => listener({ domains: installed, readId }))
}

async function load() {
  vi.resetModules()
  return import('./sidebar-pending-layer')
}

describe('sidebar pending layer', () => {
  beforeEach(() => {
    feed.lastReadId = 0
    feed.installListeners.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
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
})
