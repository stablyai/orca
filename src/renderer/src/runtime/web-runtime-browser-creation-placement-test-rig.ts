import { vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import { ENV, NOW, WT, makeSnapshot } from './web-session-tabs-sync-test-harness'

export const HOST: ExecutionHostId = `runtime:${ENV}`
export const G1 = 'group-1'
export const G2 = 'group-2'

export type MirroredRow = { unifiedTabId: string; workspaceId: string; pageId: string }

export function mirroredRow(name: string): MirroredRow {
  return {
    unifiedTabId: `${name}-tab`,
    workspaceId: `${name}-workspace`,
    pageId: `${name}-page`
  }
}

export const SOURCE = mirroredRow('source')
export const AFTER = mirroredRow('after')
export const OTHER = mirroredRow('other')

function workspace(row: MirroredRow): BrowserWorkspace {
  return {
    id: row.workspaceId,
    worktreeId: WT,
    activePageId: row.pageId,
    pageIds: [row.pageId],
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW
  }
}

function page(row: MirroredRow): BrowserPage {
  return {
    id: row.pageId,
    workspaceId: row.workspaceId,
    worktreeId: WT,
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW,
    browserRuntimeEnvironmentId: ENV,
    viewportPresetId: null
  }
}

function unifiedTab(row: MirroredRow, groupId: string, sortOrder: number): Tab {
  return {
    id: row.unifiedTabId,
    entityId: row.workspaceId,
    groupId,
    worktreeId: WT,
    executionHostId: HOST,
    contentType: 'browser',
    label: 'Example',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: NOW,
    lastFocusedAt: NOW - 10,
    isPreview: false,
    isPinned: false
  }
}

export function runtimeStatusesFor(
  capabilities: string[]
): AppState['runtimeStatusByEnvironmentId'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation reads only status.capabilities from this entry.
  return new Map([
    [ENV, { status: { capabilities }, checkedAt: 1 }]
  ]) as AppState['runtimeStatusByEnvironmentId']
}

/** G1 holds SOURCE then AFTER with SOURCE active; G2 holds OTHER and is the focused group. */
export function seedPairedWorktree(): void {
  const rows = [SOURCE, AFTER, OTHER]
  const groups: TabGroup[] = [
    {
      id: G1,
      worktreeId: WT,
      activeTabId: SOURCE.unifiedTabId,
      tabOrder: [SOURCE.unifiedTabId, AFTER.unifiedTabId],
      recentTabIds: [SOURCE.unifiedTabId]
    },
    {
      id: G2,
      worktreeId: WT,
      activeTabId: OTHER.unifiedTabId,
      tabOrder: [OTHER.unifiedTabId],
      recentTabIds: [OTHER.unifiedTabId]
    }
  ]
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: HOST,
    runtimeStatusByEnvironmentId: runtimeStatusesFor([
      'browser.screencast.v1',
      'browser.tab-create-known-id.v1'
    ]),
    browserTabsByWorktree: { [WT]: rows.map(workspace) },
    browserPagesByWorkspace: Object.fromEntries(rows.map((row) => [row.workspaceId, [page(row)]])),
    remoteBrowserPageHandlesByPageId: Object.fromEntries(
      rows.map((row) => [row.pageId, { environmentId: ENV, remotePageId: row.pageId }])
    ),
    unifiedTabsByWorktree: {
      [WT]: [unifiedTab(SOURCE, G1, 0), unifiedTab(AFTER, G1, 1), unifiedTab(OTHER, G2, 0)]
    },
    groupsByWorktree: { [WT]: groups },
    activeGroupIdByWorktree: { [WT]: G2 },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: G1 },
        second: { type: 'leaf', groupId: G2 }
      }
    },
    activeTabType: 'browser',
    activeTabTypeByWorktree: { [WT]: 'browser' },
    activeBrowserTabId: OTHER.workspaceId,
    activeBrowserTabIdByWorktree: { [WT]: OTHER.workspaceId },
    tabBarOrderByWorktree: {}
  })
}

function hostBrowserTab(
  remotePageId: string,
  hostWorkspaceId = `host-workspace-${remotePageId}`
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'browser',
    id: `host-tab-${remotePageId}`,
    title: 'Example',
    browserWorkspaceId: hostWorkspaceId,
    browserPageId: remotePageId,
    url: 'https://example.com/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

/** The host's page list; each publication mirrors every page it holds. */
export const hostPages: string[] = []
let snapshotVersion = 1

export function publishHostSnapshot(): void {
  snapshotVersion += 1
  const snapshot = makeSnapshot(
    [SOURCE.pageId, AFTER.pageId, OTHER.pageId, ...hostPages].map((id) => hostBrowserTab(id)),
    { snapshotVersion, activeTabType: 'browser', activeTabId: null }
  )
  useAppStore.setState((state) =>
    applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + snapshotVersion)
  )
}

export function resetHostPages(): void {
  hostPages.length = 0
  snapshotVersion = 1
}

type Deferred = {
  params: { page?: string; targetGroupId?: string } & Record<string, unknown>
  resolve: (browserPageId?: string) => void
  reject: (error: Error) => void
}

/** Every browser.tabCreate waits here until the test answers it. */
export const pendingCreates: Deferred[] = []

export function installRuntimeTransport(): ReturnType<typeof vi.fn> {
  pendingCreates.length = 0
  const call = vi.fn(
    (request: { method: string; params: Deferred['params'] }) =>
      new Promise((resolve, reject) => {
        if (request.method === 'browser.tabCreate') {
          pendingCreates.push({
            params: request.params,
            resolve: (browserPageId = request.params.page) => {
              if (browserPageId) {
                hostPages.push(browserPageId)
              }
              resolve({ id: 'create', ok: true, result: { browserPageId } })
            },
            reject
          })
          return
        }
        resolve({ id: request.method, ok: true, result: { closed: true } })
      })
  )
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call,
        prepareBrowserClientHostPlacement: vi.fn().mockResolvedValue({ kind: 'server' })
      }
    }
  })
  return call
}

export function groupOrder(groupId: string): string[] {
  return useAppStore.getState().groupsByWorktree[WT]?.find((g) => g.id === groupId)?.tabOrder ?? []
}

export function wrapperForRemotePage(remotePageId: string): Tab | undefined {
  const state = useAppStore.getState()
  const workspace = (state.browserTabsByWorktree[WT] ?? []).find((candidate) =>
    (state.browserPagesByWorkspace[candidate.id] ?? []).some(
      (candidatePage) =>
        state.remoteBrowserPageHandlesByPageId[candidatePage.id]?.remotePageId === remotePageId
    )
  )
  return (state.unifiedTabsByWorktree[WT] ?? []).find(
    (tab) => tab.contentType === 'browser' && tab.entityId === workspace?.id
  )
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}
