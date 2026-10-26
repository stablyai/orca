// Compare the server’s authoritative workspace layout to the tree its paired desktop actually draws (H5b, H5c).
import type { Page } from '@stablyai/playwright-test'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { decodePairingOffer } from '../../../src/shared/pairing'
import { subscribeRemoteRuntimeRequest } from '../../../src/shared/remote-runtime-client'
import { toWebTerminalSurfaceTabId } from '../../../src/shared/terminal-surface-id'
import type { PublishedWorkspaceLayout } from '../../../src/shared/workspace-layout/workspace-layout-published'
import { readWorkspaceLayoutStreamFrame } from '../../../src/shared/workspace-layout/workspace-layout-stream-frames'
import { expect } from './orca-app'
import type { HeadlessPairedRuntimeHost } from './headless-paired-runtime-host'
import type { PairedElectronClient } from './paired-electron-client'
import { leafIdsInOrder } from './workspace-layout-oracle-model'

/** Groups in order, each tab in tab order with its pane ids in tree order. */
export type Tree = { id: string; tabs: { id: string; kind: string; panes: string[] }[] }[]

/** The server's own layout of the workspace: the first snapshot of a stream of the test's own. */
export async function readServerLayout(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<PublishedWorkspaceLayout | null> {
  let resolveSnapshot: (value: unknown) => void = () => {}
  const snapshot = new Promise<unknown>((resolve) => {
    resolveSnapshot = resolve
  })
  const subscription = await subscribeRemoteRuntimeRequest<unknown>(
    pairedRuntimeConnectionFromOffer(decodePairingOffer(host.offer.pairingUrl)),
    'layout.subscribe',
    { workspaces: [worktreeId] },
    30_000,
    {
      onResponse: (response) => resolveSnapshot(response.ok ? response.result : null),
      onError: () => resolveSnapshot(null),
      onClose: () => resolveSnapshot(null)
    }
  )
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
    const frame = readWorkspaceLayoutStreamFrame(await Promise.race([snapshot, timeout]))
    if (frame?.type !== 'snapshot') {
      return null
    }
    return frame.workspaces.find((entry) => entry.key === worktreeId)?.layout ?? null
  } finally {
    subscription.close()
  }
}

/** The server's tree under the ids the desktop gives it: a terminal tab is named by its terminal. */
export function serverTree(layout: PublishedWorkspaceLayout | null): Tree | null {
  if (!layout) {
    return null
  }
  const tabsById = new Map(layout.tabs.map((tab) => [tab.id, tab]))
  return layout.groups.map((group) => ({
    id: group.id,
    tabs: group.tabIds.map((tabId) => {
      const tab = tabsById.get(tabId)
      if (!tab) {
        return { id: tabId, kind: 'missing', panes: [] }
      }
      const terminal = tab.kind === 'terminal'
      return {
        id: terminal ? toWebTerminalSurfaceTabId(tab.entityId) : tab.id,
        kind: tab.kind,
        panes: terminal ? leafIdsInOrder(tab.terminal?.root) : []
      }
    })
  }))
}

export async function desktopTree(page: Page, worktreeId: string): Promise<Tree> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    const tabs = state.unifiedTabsByWorktree[id] ?? []
    type Node = { type: 'leaf'; leafId: string } | { type: 'split'; first: Node; second: Node }
    const leaves = (node: Node | null | undefined): string[] =>
      !node
        ? []
        : node.type === 'leaf'
          ? [node.leafId]
          : [...leaves(node.first), ...leaves(node.second)]
    return (state.groupsByWorktree[id] ?? []).map((group) => ({
      id: group.id,
      tabs: group.tabOrder.map((tabId) => {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) {
          return { id: tabId, kind: 'missing', panes: [] }
        }
        return {
          id: tab.id,
          kind: tab.contentType,
          panes:
            tab.contentType === 'terminal'
              ? leaves(state.terminalLayoutsByTabId[tab.entityId]?.root)
              : []
        }
      })
    }))
  }, worktreeId)
}

/** True when frames draw it; else what the desktop knows of the server, for the failure message. */
export async function isFrameDrawn(
  client: PairedElectronClient,
  worktreeId: string
): Promise<true | { hook: boolean; verification: unknown; layoutIntents: string[] }> {
  return client.page.evaluate(
    ({ environmentId, worktreeId }) => {
      const hook = window.__isFrameDrawnServerWorkspaceE2E
      if (hook?.(environmentId, worktreeId)) {
        return true
      }
      const status = window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)
      const capabilities = status?.snapshot?.status?.capabilities ?? []
      return {
        hook: hook !== undefined,
        verification: status?.snapshot?.verification ?? null,
        layoutIntents: capabilities.filter((entry) => entry.startsWith('layout'))
      }
    },
    { environmentId: client.environmentId, worktreeId }
  )
}

/** Polls until the workspace is frame-drawn and both trees agree three reads in a row. */
export async function expectFrameDrawnTreeMatchesServer(
  host: HeadlessPairedRuntimeHost,
  client: PairedElectronClient,
  worktreeId: string,
  message: string
): Promise<Tree> {
  let streak = 0
  let settled: Tree | null = null
  await expect
    .poll(
      async () => {
        const [server, desktop, frameDrawn] = await Promise.all([
          readServerLayout(host, worktreeId).then(serverTree),
          desktopTree(client.page, worktreeId),
          isFrameDrawn(client, worktreeId)
        ])
        const match =
          frameDrawn === true &&
          server !== null &&
          JSON.stringify(server) === JSON.stringify(desktop)
        streak = match ? streak + 1 : 0
        settled = match ? server : null
        return streak >= 3 ? 'settled' : { frameDrawn, server, desktop }
      },
      { timeout: 90_000, intervals: [500], message }
    )
    .toBe('settled')
  return settled!
}
