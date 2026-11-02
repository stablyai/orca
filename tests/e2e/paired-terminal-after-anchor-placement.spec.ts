import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { toHostSessionTabId, toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

async function createTerminal(page: Page, worktreeId: string, afterTabId?: string) {
  const tabs = page.locator('[data-testid="sortable-tab"]')
  const before = await tabs.evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute('data-tab-id'))
  )
  const outcome = await page.evaluate(
    async ({ worktreeId, afterTabId }) => {
      const environment = (await window.api.runtimeEnvironments.list())[0]
      const bridge: unknown =
        '__webRuntimeSessionE2E' in window ? window.__webRuntimeSessionE2E : undefined
      if (
        !environment ||
        !bridge ||
        typeof bridge !== 'object' ||
        !('createTerminal' in bridge) ||
        typeof bridge.createTerminal !== 'function'
      ) {
        throw new Error('Paired terminal creation is unavailable')
      }
      return bridge.createTerminal({
        worktreeId,
        environmentId: environment.id,
        activate: false,
        ...(afterTabId ? { afterTabId } : {})
      })
    },
    { worktreeId, afterTabId }
  )
  expect(outcome).toEqual({ status: 'created' })
  let created: string[] = []
  await expect
    .poll(async () => {
      const ids = await tabs.evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute('data-tab-id'))
      )
      created = ids.filter((id): id is string => id !== null && !before.includes(id))
      return created.length
    })
    .toBe(1)
  const parentTabId = toHostSessionTabId(created[0])
  const surfaceId = await page.evaluate(
    async ({ worktreeId, parentTabId }) => {
      const response = await window.api.runtime.call({
        method: 'session.tabs.list',
        params: { worktree: `id:${worktreeId}` }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = response.result
      if (
        !result ||
        typeof result !== 'object' ||
        !('tabs' in result) ||
        !Array.isArray(result.tabs)
      ) {
        throw new Error('Terminal inventory is missing')
      }
      const surface: unknown = result.tabs.find((tab) => tab.parentTabId === parentTabId)
      if (
        !surface ||
        typeof surface !== 'object' ||
        !('id' in surface) ||
        typeof surface.id !== 'string'
      ) {
        throw new Error('Created terminal surface is missing')
      }
      return surface.id
    },
    { worktreeId, parentTabId }
  )
  return { id: toWebTerminalSurfaceTabId(surfaceId), parentTabId }
}

async function tabWindow(page: Page, anchor: string) {
  return page.locator('[data-testid="sortable-tab"]').evaluateAll((tabs, anchor) => {
    const ids = tabs.map((tab) => tab.getAttribute('data-tab-id'))
    const index = ids.indexOf(anchor)
    return index === -1 ? [] : ids.slice(index, index + 3)
  }, anchor)
}

test('paired web creation places a terminal after its anchor on both host and client', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer)
  try {
    const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
    if (!worktreeId) {
      throw new Error('Paired worktree is missing')
    }
    await client.page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    await expect(
      client.page.locator('[data-testid="sortable-tab"][data-active="true"]')
    ).toBeVisible()
    const first = await createTerminal(client.page, worktreeId)
    const second = await createTerminal(client.page, worktreeId)
    const inserted = await createTerminal(client.page, worktreeId, first.id)
    const labels = [first, second, inserted].map((tab, index) => ({
      id: tab.parentTabId,
      webId: toWebTerminalSurfaceTabId(tab.parentTabId),
      title: ['Anchor A', 'Successor B', 'Inserted C'][index]
    }))
    for (const [page, web] of [
      [orcaPage, false],
      [client.page, true]
    ] as const) {
      await page.evaluate(
        ({ labels, web }) => {
          for (const { id, webId, title } of labels) {
            window.__store?.getState().setTabCustomTitle(web ? webId : id, title)
          }
        },
        { labels, web }
      )
    }
    await expect
      .poll(() => tabWindow(orcaPage, first.parentTabId), { timeout: 15_000 })
      .toEqual([first.parentTabId, inserted.parentTabId, second.parentTabId])
    const clientIds = [first, inserted, second].map((tab) =>
      toWebTerminalSurfaceTabId(tab.parentTabId)
    )
    await expect
      .poll(() => tabWindow(client.page, clientIds[0]), { timeout: 15_000 })
      .toEqual(clientIds)
  } finally {
    await testInfo.attach('host-tab-placement', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('host-tab-placement.png') }),
      contentType: 'image/png'
    })
    await testInfo.attach('client-tab-placement', {
      body: await client.page.screenshot({ path: testInfo.outputPath('client-tab-placement.png') }),
      contentType: 'image/png'
    })
    await client.dispose()
  }
})
