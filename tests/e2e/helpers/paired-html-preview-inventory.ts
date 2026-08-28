import type { Page } from '@stablyai/playwright-test'

export type PairedHtmlPreviewInventory = {
  clientRemotePageIds: string[]
  clientUnifiedTabs: { groupId: string; id: string }[]
  clientWorkspaceIds: string[]
  hostPageIds: string[]
  hostTabs: { browserPageId: string | null; id: string }[]
  hostResponseError: string | null
  hostResponseOk: boolean
  hostTabGroups: { id: string; tabOrder: string[] }[]
  hostTabIds: string[]
  totalClientUnified: number
  totalClientWorkspaces: number
  totalHost: number
}

export async function readPairedHtmlPreviewInventory(
  page: Page,
  args: {
    environmentId: string
    fixtureName: string
    worktreeId: string
  }
): Promise<PairedHtmlPreviewInventory> {
  return page.evaluate(async ({ environmentId, fixtureName, worktreeId }) => {
    const fault = (
      window as Window & {
        __webRuntimeBrowserCreationFault?: { takeInventoryRpcFailure: () => string | null }
      }
    ).__webRuntimeBrowserCreationFault?.takeInventoryRpcFailure()
    const response = fault
      ? ({
          ok: false,
          error: { code: fault, message: 'E2E forced inventory RPC failure' }
        } as const)
      : await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'session.tabs.list',
          params: { worktree: `id:${worktreeId}` },
          timeoutMs: 15_000
        })
    const state = window.__store?.getState()
    const hostResponseOk = response.ok
    const hostResponseError = response.ok ? null : JSON.stringify(response.error)
    const clientWorkspaces = (state?.browserTabsByWorktree[worktreeId] ?? []).filter((tab) =>
      tab.url.endsWith(`/${fixtureName}`)
    )
    const clientWorkspaceIds = clientWorkspaces.map((tab) => tab.id)
    const clientPages = clientWorkspaces.flatMap(
      (workspace) => state?.browserPagesByWorkspace[workspace.id] ?? []
    )
    const hostTabs = hostResponseOk
      ? response.result.tabs.filter(
          (tab) => tab.type === 'browser' && tab.url.endsWith(`/${fixtureName}`)
        )
      : []
    return {
      clientRemotePageIds: clientPages.flatMap((browserPage) => {
        const remotePageId = state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.remotePageId
        return remotePageId ? [remotePageId] : []
      }),
      clientUnifiedTabs: (state?.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.contentType === 'browser' && clientWorkspaceIds.includes(tab.entityId))
        .map((tab) => ({ groupId: tab.groupId, id: tab.id })),
      clientWorkspaceIds,
      hostPageIds: hostTabs.flatMap((tab) =>
        tab.type === 'browser' && tab.browserPageId ? [tab.browserPageId] : []
      ),
      hostTabs: hostTabs.map((tab) => ({
        browserPageId: tab.type === 'browser' ? (tab.browserPageId ?? null) : null,
        id: tab.id
      })),
      hostResponseError,
      hostResponseOk,
      hostTabGroups: hostResponseOk ? (response.result.tabGroups ?? []) : [],
      hostTabIds: hostTabs.map((tab) => tab.id),
      totalClientUnified: (state?.unifiedTabsByWorktree[worktreeId] ?? []).filter(
        (tab) => tab.contentType === 'browser'
      ).length,
      totalClientWorkspaces: (state?.browserTabsByWorktree[worktreeId] ?? []).length,
      totalHost: hostResponseOk
        ? response.result.tabs.filter((tab) => tab.type === 'browser').length
        : -1
    }
  }, args)
}

type BrowserCreationFaultWindow = Window & {
  __webRuntimeBrowserCreationFault?: {
    armInventoryRpcFailure: () => void
    armSettlement: () => void
    waitForSettlement: () => Promise<
      { status: 'fulfilled'; created: boolean } | { status: 'rejected'; error: string }
    >
  }
}

export async function armPairedHtmlPreviewCreationObservation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fault = (window as BrowserCreationFaultWindow).__webRuntimeBrowserCreationFault
    if (!fault) {
      throw new Error('Browser creation E2E observation seam unavailable')
    }
    fault.armSettlement()
  })
}

export async function armPairedHtmlPreviewInventoryRpcFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fault = (window as BrowserCreationFaultWindow).__webRuntimeBrowserCreationFault
    if (!fault) {
      throw new Error('Browser inventory E2E fault seam unavailable')
    }
    fault.armInventoryRpcFailure()
  })
}

export async function waitForPairedHtmlPreviewCreationSettlement(page: Page): Promise<void> {
  const settlement = await page.evaluate(async () => {
    const fault = (window as BrowserCreationFaultWindow).__webRuntimeBrowserCreationFault
    if (!fault) {
      throw new Error('Browser creation E2E observation seam unavailable')
    }
    return fault.waitForSettlement()
  })
  if (settlement.status !== 'fulfilled' || !settlement.created) {
    throw new Error(
      settlement.status === 'rejected'
        ? `Remote HTML preview creation rejected: ${settlement.error}`
        : 'Remote HTML preview creation did not succeed'
    )
  }
}
