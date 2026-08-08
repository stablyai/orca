import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible } from './helpers/store'
import { waitForActivePanePtyId } from './helpers/terminal'

type DestinationServer = {
  url: string
  close: () => Promise<void>
}

type PairedWorktree = {
  id: string
  path: string
}

/** Surfaces marker-server shutdown failures instead of leaking them across E2E cases. */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
    server.closeAllConnections()
  })
}

/** Provides client-local content that distinguishes the desktop browser from its paired runtime. */
async function startDestinationServer(): Promise<DestinationServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><title>Local browser destination</title></head>
        <body><h1 id="browser-host-marker">Opened on this computer</h1></body>
      </html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/destination`,
    close: () => closeServer(server)
  }
}

/** Removes the optional announcement that can obscure Browser settings in fresh profiles. */
async function dismissTransientAnnouncement(page: Page): Promise<void> {
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  await maybeLaterButton.waitFor({ state: 'visible', timeout: 1_000 }).then(
    () => maybeLaterButton.click(),
    () => undefined
  )
}

/** Opens Browser settings without taking control of the active desktop. */
async function openBrowserSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Paired desktop store is unavailable')
    }
    state.openSettingsTarget({ pane: 'browser', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
}

/** Seeds the opposite host choice so the rendered control must perform the transition under test. */
async function seedWorkspaceBrowserHost(page: Page, browserDefaultUrl: string): Promise<void> {
  await page.evaluate(
    async ({ browserDefaultUrl }) => {
      const nextSettings = await window.api.settings.set({
        browserTabHost: 'workspace',
        openLinksInApp: false,
        openLinksInAppPreferencePrompted: true
      })
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired desktop store is unavailable')
      }
      window.__store?.setState({ settings: nextSettings })
      state.setBrowserDefaultUrl(browserDefaultUrl)
    },
    { browserDefaultUrl }
  )
}

/** Exercises the visible selector and verifies both persistence and renderer reconciliation. */
async function setBrowserTabHostToLocalThroughUi(page: Page): Promise<void> {
  const search = page.getByPlaceholder('Search settings')
  await search.fill('link routing')
  const linkRoutingSwitch = page.getByRole('switch', { name: 'Link Routing' })
  await expect(linkRoutingSwitch).toBeVisible()
  await expect(linkRoutingSwitch).toHaveAttribute('aria-checked', 'false')

  await search.fill('browser tab host')
  await expect(page.getByText('Browser tab host', { exact: true }).first()).toBeVisible()
  await expect(
    page
      .getByText('Choose where new browser tabs and links routed into Orca Browser run.', {
        exact: true
      })
      .first()
  ).toBeVisible()
  const browserHostSelect = page.getByRole('combobox').filter({
    hasText: 'Workspace runtime'
  })
  await expect(browserHostSelect).toBeVisible()

  await browserHostSelect.evaluate((element) => {
    const trigger = element as HTMLElement
    trigger.focus()
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter'
      })
    )
  })
  await expect(page.locator('[data-slot="select-trigger"][aria-expanded="true"]')).toHaveCount(1)
  const localOption = page.getByRole('option', { name: 'This computer', exact: true })
  await expect(localOption).toBeAttached({ timeout: 5_000 })
  await localOption.evaluate((element) => {
    const option = element as HTMLElement
    option.focus()
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
    )
  })
  await expect
    .poll(async () => (await page.evaluate(() => window.api.settings.get())).browserTabHost)
    .toBe('local')
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().settings?.browserTabHost))
    .toBe('local')
}

/** Activates the runtime-owned worktree only after its paired projection is authoritative. */
async function activatePairedWorktree(page: Page, repoId: string): Promise<PairedWorktree> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (targetRepoId) => {
          const state = window.__store?.getState()
          if (!state) {
            return null
          }
          await state.fetchRepos()
          await state.fetchWorktrees(targetRepoId)
          const worktree = state.worktreesByRepo[targetRepoId]?.find(
            (candidate) => candidate.isMainWorktree
          )
          return worktree ? { id: worktree.id, path: worktree.path } : null
        }, repoId),
      { timeout: 30_000, message: 'Paired desktop did not project the runtime worktree' }
    )
    .not.toBeNull()

  const worktree = await page.evaluate((targetRepoId) => {
    const state = window.__store?.getState()
    const candidate = state?.worktreesByRepo[targetRepoId]?.find((entry) => entry.isMainWorktree)
    return candidate ? { id: candidate.id, path: candidate.path } : null
  }, repoId)
  if (!worktree) {
    throw new Error('Paired runtime worktree disappeared after discovery')
  }

  await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Paired desktop store is unavailable')
    }
    state.setActiveWorktree(worktreeId)
  }, worktree.id)
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktree.id
  )
  await ensureTerminalVisible(page, 30_000)
  return worktree
}

/** Correlates store, tab-strip, webview, and marker evidence for the newly created local tab. */
async function readNewBrowserDestination(
  page: Page,
  worktreeId: string,
  existingBrowserTabIds: string[]
): Promise<{
  activeGroupTabType: string | null
  activeTabType: string | null | undefined
  activeView: string
  browserRuntimeEnvironmentId: string | null | undefined
  hasBrowserPage: boolean
  hasOverlay: boolean
  hasWebview: boolean
  marker: string | null
  tabId: string | null
  terminalTabIds: string[]
  renderedActiveWorktreeId: string | null
  renderErrorText: string | null
  unifiedBrowserTabCount: number
  url: string | null
} | null> {
  return page.evaluate(
    async ({ existingBrowserTabIds, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        return null
      }
      const tab = (state.browserTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => !existingBrowserTabIds.includes(candidate.id)
      )
      const browserPage =
        tab?.activePageId === undefined
          ? undefined
          : state.browserPagesByWorkspace[tab.id]?.find(
              (candidate) => candidate.id === tab.activePageId
            )
      const overlay = tab
        ? document.querySelector(`[data-browser-overlay-tab-id="${tab.id}"]`)
        : null
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
      let marker: string | null = null
      try {
        marker = webview
          ? ((await webview.executeJavaScript(
              'document.querySelector("#browser-host-marker")?.textContent ?? null'
            )) as string | null)
          : null
      } catch {
        marker = null
      }
      const activeGroupTabId = (state.groupsByWorktree[worktreeId] ?? []).find(
        (group) => group.id === state.activeGroupIdByWorktree[worktreeId]
      )?.activeTabId
      return {
        activeGroupTabType:
          (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
            (unifiedTab) => unifiedTab.id === activeGroupTabId
          )?.contentType ?? null,
        activeTabType: state.activeTabTypeByWorktree[worktreeId],
        activeView: state.activeView,
        browserRuntimeEnvironmentId: browserPage?.browserRuntimeEnvironmentId,
        hasBrowserPage: browserPage !== undefined,
        hasOverlay: overlay !== null,
        hasWebview: Boolean(webview),
        marker,
        tabId: tab?.id ?? null,
        terminalTabIds: (state.tabsByWorktree[worktreeId] ?? []).map(
          (terminalTab) => terminalTab.id
        ),
        renderedActiveWorktreeId:
          document
            .querySelector('[data-rendered-active-worktree-id]')
            ?.getAttribute('data-rendered-active-worktree-id') ?? null,
        renderErrorText:
          [...document.querySelectorAll('[role="alert"]')]
            .map((element) => element.textContent)
            .find((text) => text?.includes('workspace workbench')) ?? null,
        unifiedBrowserTabCount: (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
          (unifiedTab) => unifiedTab.contentType === 'browser'
        ).length,
        url: browserPage?.url ?? null
      }
    },
    { existingBrowserTabIds, worktreeId }
  )
}

test('paired New Browser Tab stays local when Browser tab host is This computer', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const server = await startDestinationServer()
  let client: PairedElectronClient | null = null
  const rendererErrors: string[] = []

  try {
    const repoId = await orcaPage.evaluate((repoPath) => {
      const repo = window.__store?.getState().repos.find((candidate) => candidate.path === repoPath)
      if (!repo) {
        throw new Error(`HUB test repo is unavailable: ${repoPath}`)
      }
      return repo.id
    }, testRepoPath)

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(offer, testInfo, 'Browser tab host user test', {
      waitForInitialWorkspaceSessionReady: false
    })
    client.page.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text())
      }
    })
    client.page.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message))
    await client.page.setViewportSize({ width: 1600, height: 1000 })
    const worktree = await activatePairedWorktree(client.page, repoId)
    await waitForActivePanePtyId(client.page, 30_000)

    await seedWorkspaceBrowserHost(client.page, server.url)
    await openBrowserSettings(client.page)
    const search = client.page.getByPlaceholder('Search settings')
    await search.fill('cookies')
    await expect(client.page.getByText('Profile & Cookie Host', { exact: true })).toBeVisible()
    await expect(
      client.page.getByText(/This does not control where browser tabs run\./).first()
    ).toBeVisible()
    await setBrowserTabHostToLocalThroughUi(client.page)

    const before = await client.page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      return {
        browserTabIds: (state?.browserTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        terminalTabIds: (state?.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
      }
    }, worktree.id)

    await client.page.evaluate(async (worktreeId) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired desktop store is unavailable')
      }
      state.closeSettingsPage()
      await state.openNewBrowserTabInActiveWorkspace(state.activeGroupIdByWorktree[worktreeId])
    }, worktree.id)

    await expect
      .poll(
        () =>
          client!.page.evaluate((worktreeId) => {
            const state = window.__store?.getState()
            return (state?.browserTabsByWorktree[worktreeId] ?? []).length
          }, worktree.id),
        { timeout: 15_000, message: 'New Browser Tab did not create a local browser tab' }
      )
      .toBe(before.browserTabIds.length + 1)

    let destination: Awaited<ReturnType<typeof readNewBrowserDestination>> = null
    await expect
      .poll(
        async () => {
          destination = await readNewBrowserDestination(
            client!.page,
            worktree.id,
            before.browserTabIds
          )
          if (destination?.renderErrorText) {
            throw new Error(
              `Paired desktop workbench crashed:\n${rendererErrors.join('\n') || destination.renderErrorText}`
            )
          }
          return destination
        },
        {
          timeout: 20_000,
          message: 'The new local browser tab did not load its configured home page'
        }
      )
      .toMatchObject({
        activeGroupTabType: 'browser',
        activeTabType: 'browser',
        activeView: 'terminal',
        browserRuntimeEnvironmentId: null,
        hasBrowserPage: true,
        hasOverlay: true,
        hasWebview: true,
        marker: 'Opened on this computer',
        renderedActiveWorktreeId: worktree.id,
        renderErrorText: null,
        terminalTabIds: before.terminalTabIds,
        unifiedBrowserTabCount: 1,
        url: server.url
      })

    const activeBrowserTab = client.page.locator(`[data-tab-id="${destination!.tabId}"]`)
    await expect(activeBrowserTab).toBeVisible()
    await expect(
      client.page.locator(`[data-browser-overlay-tab-id="${destination!.tabId}"]`)
    ).toHaveCSS('opacity', '1')
    await expect(client.page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      worktree.id
    )
  } finally {
    await Promise.resolve(client?.dispose()).finally(() => server.close())
  }
})
