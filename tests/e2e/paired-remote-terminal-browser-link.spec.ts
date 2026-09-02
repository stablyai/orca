import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import {
  readClientGuestState,
  readOwnedPageUrls,
  readScreencastSubscribeCount,
  sendClientGuestKeyboardInput,
  sendClientGuestPointerInput
} from './helpers/client-hosted-browser-observer'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  readPanelNavigationObserver,
  startPanelNavigationObserver,
  stopPanelNavigationObserver
} from './helpers/plugin-panel-navigation-observer'
import {
  readTerminalMultiplexLifecycle,
  readTerminalReconnectUiEvents,
  startTerminalReconnectUiObserver
} from './helpers/remote-terminal-lifecycle-observer'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const PAGE_MARKER = 'remote terminal browser owner'
const POINTER_MARKER = 'local pointer received'
const KEYBOARD_MARKER = 'local-keyboard-input'
const TERMINAL_MARKER = 'remote-terminal-still-live-after-browser-close'

async function readTabInventory(
  page: Page,
  environmentId: string,
  worktreeId: string
): Promise<{
  clientBrowserWorkspaces: number
  clientBrowserTabs: number
  clientTerminalTabs: number
  hostAuthoritativeBrowserTabs: number
  hostRegisteredBrowserPages: number
  hostTerminalTabs: number
}> {
  return page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const state = window.__store?.getState()
      const [sessionResponse, browserResponse] = await Promise.all([
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'session.tabs.list',
          params: { worktree: `id:${worktreeId}` },
          timeoutMs: 15_000
        }),
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'browser.tabList',
          params: { worktree: `id:${worktreeId}` },
          timeoutMs: 15_000
        })
      ])
      if (!sessionResponse.ok) {
        throw new Error('host session tab inventory unavailable')
      }
      if (!browserResponse.ok) {
        throw new Error('host browser page inventory unavailable')
      }
      return {
        clientBrowserWorkspaces: (state?.browserTabsByWorktree[worktreeId] ?? []).length,
        clientBrowserTabs: (state?.unifiedTabsByWorktree[worktreeId] ?? []).filter(
          (tab) => tab.contentType === 'browser'
        ).length,
        clientTerminalTabs: (state?.tabsByWorktree[worktreeId] ?? []).length,
        hostAuthoritativeBrowserTabs: sessionResponse.result.tabs.filter(
          (tab) => tab.type === 'browser'
        ).length,
        hostRegisteredBrowserPages: browserResponse.result.tabs.length,
        hostTerminalTabs: sessionResponse.result.tabs.filter((tab) => tab.type === 'terminal')
          .length
      }
    },
    { environmentId, worktreeId }
  )
}

async function startPageServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>
      <h1 id="marker">${PAGE_MARKER}</h1>
      <button id="pointer-target" onclick="this.textContent='${POINTER_MARKER}'">pointer</button>
      <input id="keyboard-target" aria-label="keyboard target">
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${address.port}/remote-terminal` }
}

async function closePageServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function findTerminalLinkTarget(page: Page, link: string): Promise<{ x: number; y: number }> {
  return page.evaluate((targetLink) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
    if (!pane || !screen) {
      throw new Error('paired terminal screen unavailable')
    }
    const buffer = pane.terminal.buffer.active
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const text = buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ''
      const column = text.indexOf(targetLink)
      if (column === -1) {
        continue
      }
      const cell = pane.terminal.dimensions?.css.cell
      if (!cell?.width || !cell.height) {
        throw new Error('paired terminal cell dimensions unavailable')
      }
      const rect = screen.getBoundingClientRect()
      return {
        x: rect.left + (column + targetLink.length / 2) * cell.width,
        y: rect.top + (row + 0.5) * cell.height
      }
    }
    throw new Error('paired terminal link unavailable')
  }, link)
}

function remoteTerminalHandle(ptyId: string): string {
  const separator = ptyId.indexOf('@@')
  if (!ptyId.startsWith('remote:') || separator === -1) {
    throw new Error(`Expected runtime-owned PTY id, received ${ptyId}`)
  }
  return decodeURIComponent(ptyId.slice(separator + 2))
}

test('opens a paired-runtime terminal link on its owning host', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = await startPageServer()
  let client: PairedElectronClient | null = null
  let observerActive = false
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const hostPtyId = await waitForActivePanePtyId(orcaPage)
    await execInTerminal(orcaPage, hostPtyId, `printf '%s\\n' ${JSON.stringify(fixture.url)}`)
    await waitForTerminalOutput(orcaPage, fixture.url)

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(offer, testInfo, 'Remote terminal browser link')
    const page = client.page
    const worktreeId = await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
          }, testRepoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((repoPath) => {
          const state = window.__store?.getState()
          return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
        }, testRepoPath)
      )
    if (!worktreeId) {
      throw new Error('paired client worktree disappeared after discovery')
    }
    await page.evaluate(
      async ({ environmentId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        await state?.updateSettings({
          openLinksInApp: true,
          terminalLinkActionPopoverEnabled: true
        })
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForTerminalOutput(page, fixture.url, 30_000)
    const clientPtyId = await waitForActivePanePtyId(page, 30_000)
    expect(clientPtyId.startsWith(`remote:${client.environmentId}@@`)).toBe(true)

    const baseline = await readTabInventory(page, client.environmentId, worktreeId)
    const terminalLifecycle = await readTerminalMultiplexLifecycle(page)
    expect(terminalLifecycle.activeStreams).toContainEqual({
      environmentId: client.environmentId,
      streamId: expect.any(Number),
      terminal: remoteTerminalHandle(clientPtyId)
    })
    const screencastSubscribeCount = await readScreencastSubscribeCount(page)
    await startTerminalReconnectUiObserver(page)
    await startPanelNavigationObserver(client.app, page.url())
    observerActive = true

    const target = await findTerminalLinkTarget(page, fixture.url)
    await page.mouse.move(target.x, target.y)
    await expect(page.locator('.xterm-hover')).toHaveCount(1)
    await page.mouse.click(target.x, target.y)
    const actionPopover = page.locator('[data-terminal-link-action-popover]')
    await expect(actionPopover).toBeVisible()
    await expect(actionPopover.locator('[data-terminal-link-destination]')).toHaveText(fixture.url)
    await expect(
      actionPopover.getByRole('button').filter({ hasText: 'System Browser' })
    ).toBeVisible()
    const orcaBrowserAction = actionPopover.getByRole('button').filter({ hasText: 'Orca Browser' })
    await expect(orcaBrowserAction).toBeVisible()
    await orcaBrowserAction.click()

    const identity = await expect
      .poll(
        () =>
          page.evaluate(
            ({ url, worktreeId }) => {
              const state = window.__store?.getState()
              const workspace = (state?.browserTabsByWorktree[worktreeId] ?? []).find(
                (tab) => tab.url === url
              )
              const browserPage = workspace
                ? (state?.browserPagesByWorkspace[workspace.id] ?? [])[0]
                : null
              const handle = browserPage
                ? state?.remoteBrowserPageHandlesByPageId[browserPage.id]
                : null
              return workspace && browserPage && handle?.placement?.kind === 'client'
                ? {
                    clientPageId: browserPage.id,
                    clientRuntimeId: browserPage.browserRuntimeEnvironmentId,
                    clientWorkspaceId: workspace.id,
                    placement: handle.placement,
                    remoteEnvironmentId: handle.environmentId,
                    remotePageId: handle.remotePageId
                  }
                : null
            },
            { url: fixture.url, worktreeId }
          ),
        { timeout: 60_000, message: 'terminal link never became one client-hosted browser page' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate(
          ({ url, worktreeId }) => {
            const state = window.__store!.getState()
            const workspace = state.browserTabsByWorktree[worktreeId]!.find(
              (tab) => tab.url === url
            )!
            const browserPage = state.browserPagesByWorkspace[workspace.id]![0]!
            const handle = state.remoteBrowserPageHandlesByPageId[browserPage.id]!
            return {
              clientPageId: browserPage.id,
              clientRuntimeId: browserPage.browserRuntimeEnvironmentId,
              clientWorkspaceId: workspace.id,
              placement: handle.placement,
              remoteEnvironmentId: handle.environmentId,
              remotePageId: handle.remotePageId
            }
          },
          { url: fixture.url, worktreeId }
        )
      )

    expect(identity.clientRuntimeId).toBe(client.environmentId)
    expect(identity.remoteEnvironmentId).toBe(client.environmentId)
    expect(identity.placement).toMatchObject({ kind: 'client' })
    const finalInventory = await readTabInventory(page, client.environmentId, worktreeId)
    expect(finalInventory).toEqual({
      clientBrowserWorkspaces: baseline.clientBrowserWorkspaces + 1,
      clientBrowserTabs: baseline.clientBrowserTabs + 1,
      clientTerminalTabs: baseline.clientTerminalTabs,
      hostAuthoritativeBrowserTabs: baseline.hostAuthoritativeBrowserTabs + 1,
      hostRegisteredBrowserPages: baseline.hostRegisteredBrowserPages + 1,
      hostTerminalTabs: baseline.hostTerminalTabs
    })
    await expect
      .poll(() => readOwnedPageUrls(client!.app, fixture.url), {
        timeout: 60_000,
        message: 'client-hosted guest never loaded on the paired desktop'
      })
      .toHaveLength(1)
    expect(await readOwnedPageUrls(electronApp, fixture.url)).toHaveLength(0)
    await expect(page.getByTestId('remote-browser-frame')).toHaveCount(0)
    expect(await readScreencastSubscribeCount(page)).toBe(screencastSubscribeCount)
    expect((await readPanelNavigationObserver(client.app)).externalUrls).toEqual([])

    const content = await page.evaluate(
      async ({ browserPageId, environmentId, worktreeId }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'browser.eval',
          params: {
            worktree: `id:${worktreeId}`,
            page: browserPageId,
            expression: 'document.querySelector("h1")?.textContent'
          },
          timeoutMs: 15_000
        }),
      {
        browserPageId: identity.remotePageId,
        environmentId: client.environmentId,
        worktreeId
      }
    )
    expect(content).toMatchObject({ ok: true, result: { result: PAGE_MARKER } })

    const browserTab = page.locator(`[data-tab-id="${identity.clientWorkspaceId}"]`)
    await browserTab.click()
    await expect
      .poll(() =>
        page.evaluate((worktreeId) => {
          const state = window.__store?.getState()
          return {
            browserWorkspaceId: state?.activeBrowserTabIdByWorktree[worktreeId] ?? null,
            tabType: state?.activeTabTypeByWorktree[worktreeId] ?? null
          }
        }, worktreeId)
      )
      .toEqual({ browserWorkspaceId: identity.clientWorkspaceId, tabType: 'browser' })
    await expect(
      page.locator(`[data-browser-overlay-tab-id="${identity.clientWorkspaceId}"]`)
    ).toHaveCSS('opacity', '1')
    await expect
      .poll(() => readClientGuestState(page, fixture.url), {
        timeout: 30_000,
        message: 'client-hosted guest DOM never became readable'
      })
      .toMatchObject({ marker: PAGE_MARKER })
    await sendClientGuestPointerInput(page, fixture.url, '#pointer-target')
    await expect
      .poll(() => readClientGuestState(page, fixture.url))
      .toMatchObject({
        pointerValue: POINTER_MARKER
      })
    await sendClientGuestPointerInput(page, fixture.url, '#keyboard-target')
    await expect
      .poll(() => readClientGuestState(page, fixture.url))
      .toMatchObject({ focusedElement: 'keyboard-target' })
    await sendClientGuestKeyboardInput(page, fixture.url, KEYBOARD_MARKER)
    await expect
      .poll(() => readClientGuestState(page, fixture.url))
      .toMatchObject({
        keyboardValue: KEYBOARD_MARKER
      })
    expect(await readTerminalMultiplexLifecycle(page)).toEqual(terminalLifecycle)
    expect(await readTerminalReconnectUiEvents(page)).toEqual([])
    expect(await readScreencastSubscribeCount(page)).toBe(screencastSubscribeCount)

    await browserTab.hover()
    await browserTab.locator('button').click()
    await expect
      .poll(() => readTabInventory(page, client!.environmentId, worktreeId), {
        timeout: 30_000,
        message: 'host and client browser inventories did not return to baseline'
      })
      .toEqual(baseline)

    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    expect(await waitForActivePanePtyId(page, 30_000)).toBe(clientPtyId)
    const send = await page.evaluate(
      async ({ environmentId, terminal, text }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'terminal.send',
          params: {
            terminal,
            text,
            enter: true,
            client: { id: 'remote-browser-close-e2e', type: 'desktop' }
          },
          timeoutMs: 15_000
        }),
      {
        environmentId: client.environmentId,
        terminal: remoteTerminalHandle(clientPtyId),
        text: `printf '%s\\n' ${JSON.stringify(TERMINAL_MARKER)}`
      }
    )
    expect(send).toMatchObject({ ok: true, result: { send: { accepted: true } } })
    await waitForTerminalOutput(page, TERMINAL_MARKER, 30_000)
    expect(await readTabInventory(page, client.environmentId, worktreeId)).toEqual(baseline)
    expect(await readTerminalMultiplexLifecycle(page)).toEqual(terminalLifecycle)
    expect(await readTerminalReconnectUiEvents(page)).toEqual([])
    expect(await readScreencastSubscribeCount(page)).toBe(screencastSubscribeCount)
    expect((await readPanelNavigationObserver(client.app)).externalUrls).toEqual([])
  } finally {
    if (observerActive && client) {
      await stopPanelNavigationObserver(client.app).catch(() => undefined)
    }
    try {
      await client?.dispose()
    } finally {
      await closePageServer(fixture.server)
    }
  }
})
