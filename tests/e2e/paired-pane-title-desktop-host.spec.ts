// #30329/#30386: with two hidden desktops, client pane rename must reach host layout authority and later host rename must reach the already-open client pane.
import type { Page } from '@stablyai/playwright-test'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { setPaneTitleFromTerminalMenu } from './helpers/terminal-pane-title-actions'

/** Creates a terminal on the host through the client's runtime and returns its surface tab id. */
async function createHostTerminal(page: Page, environmentId: string, worktreeId: string) {
  return page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'session.tabs.createTerminal',
        params: {
          worktree: `id:${worktreeId}`,
          activate: false,
          select: false,
          navigation: 'caller'
        }
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      const result: unknown = response.result
      const tab = result && typeof result === 'object' && 'tab' in result ? result.tab : undefined
      const id = tab && typeof tab === 'object' && 'id' in tab ? tab.id : undefined
      if (typeof id !== 'string') {
        throw new Error('host did not return the created terminal tab')
      }
      return id
    },
    { environmentId, worktreeId }
  )
}

async function showTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await page.evaluate(
    ({ worktreeId, tabId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(tabId)
      state?.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
    },
    { worktreeId, tabId }
  )
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, tabId), {
      timeout: 60_000,
      message: `pane for ${tabId} never mounted`
    })
    .toBe(true)
}

function shownPaneTitles(page: Page): Promise<string[]> {
  return page.locator('.pane-title-text').allTextContents()
}

test('pane names travel between a desktop host and its paired client, live', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'pane-title-desktop-host')
  try {
    const worktreeId = await orcaPage.evaluate(() => {
      const id = window.__store?.getState().activeWorktreeId
      if (!id) {
        throw new Error('host has no active worktree')
      }
      return id
    })
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000, message: 'paired client never saw the host worktree' }
      )
      .toBe(true)
    const createdTabId = await createHostTerminal(client.page, client.environmentId, worktreeId)
    const hostTabId = createdTabId.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
    const webTabId = toWebTerminalSurfaceTabId(hostTabId)
    const hostTabTitle = () =>
      orcaPage.evaluate(
        ({ worktreeId, tabId }) =>
          (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).find(
            (tab) => tab.id === tabId
          )?.customTitle ?? null,
        { worktreeId, tabId: hostTabId }
      )

    await showTab(orcaPage, worktreeId, hostTabId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
            worktreeId
          ),
        { timeout: 60_000, message: 'client never mirrored the host tab' }
      )
      .toContain(webTabId)
    await showTab(client.page, worktreeId, webTabId)
    const tabTitleBefore = await hostTabTitle()

    // #30386 gap 1: the client's pane rename reaches the host's window, and only as a pane name.
    await setPaneTitleFromTerminalMenu(client.page, 'client-named')
    await expect
      .poll(() => shownPaneTitles(orcaPage), {
        timeout: 30_000,
        message: "the host window never showed the client's pane name"
      })
      .toContain('client-named')
    expect(await hostTabTitle()).toBe(tabTitleBefore)

    // #30386 gap 2: a name the host sets reaches the client's already-open pane.
    await setPaneTitleFromTerminalMenu(orcaPage, 'host-named')
    await expect
      .poll(() => shownPaneTitles(client.page), {
        timeout: 30_000,
        message: "the client's open pane never showed the host's pane name"
      })
      .toContain('host-named')
    expect(await shownPaneTitles(client.page)).not.toContain('client-named')
    expect(await hostTabTitle()).toBe(tabTitleBefore)
    await testInfo.attach('host', { body: await orcaPage.screenshot(), contentType: 'image/png' })
    await testInfo.attach('client', {
      body: await client.page.screenshot(),
      contentType: 'image/png'
    })
  } finally {
    await client.dispose()
  }
})
