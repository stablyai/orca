import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  startDockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import {
  readSshRemoteOnlyRequests,
  SSH_REMOTE_ONLY_ORIGIN,
  SSH_REMOTE_ONLY_PORT,
  startSshRemoteOnlyBrowserFixture
} from './helpers/ssh-remote-only-browser-fixture'
import { convertAndRetain } from './helpers/orcad-convert-flow'
import {
  activateManagedWorkspace,
  expectPaneText,
  managedEnvironmentId,
  openTerminalTab,
  ORCAD_TEMPLATE,
  skipUnlessManagedDockerHost,
  typeInTerminal
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

async function terminalLinkPoint(
  page: Page,
  tabId: string,
  link: string
): Promise<{ x: number; y: number }> {
  const readPoint = () =>
    page.evaluate(
      ({ tabId, link }) => {
        const pane = window.__paneManagers?.get(tabId)?.getActivePane?.()
        const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
        if (!pane || !screen) {
          return null
        }
        // A browser split can resize the container before xterm fits and paints its new grid.
        const proposed = pane.fitAddon.proposeDimensions()
        if (
          !proposed ||
          pane.terminal.cols !== proposed.cols ||
          pane.terminal.rows !== proposed.rows
        ) {
          return null
        }
        const buffer = pane.terminal.buffer.active
        const renderedRows = screen.querySelector('.xterm-rows')
        for (const [row, renderedRow] of Array.from(
          Array.from(renderedRows?.children ?? []).entries()
        ).toReversed()) {
          const column = renderedRow.textContent?.indexOf(link) ?? -1
          const current = buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ''
          if (column < 0 || current.indexOf(link) !== column) {
            continue
          }
          let offset = column + Math.floor(link.length / 2)
          const walker = document.createTreeWalker(renderedRow, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent?.length ?? 0
            if (offset >= length) {
              offset -= length
              continue
            }
            const range = document.createRange()
            range.setStart(node, offset)
            range.setEnd(node, offset + 1)
            const rect = range.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            }
          }
        }
        if (renderedRows) {
          return null
        }
        const rect = screen.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          return null
        }
        const cell = {
          width: rect.width / pane.terminal.cols,
          height: rect.height / pane.terminal.rows
        }
        for (let row = pane.terminal.rows - 1; row >= 0; row -= 1) {
          const text = buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ''
          const column = text.indexOf(link)
          if (column !== -1) {
            return {
              x: rect.left + (column + link.length / 2) * cell.width,
              y: rect.top + (row + 0.5) * cell.height
            }
          }
        }
        return null
      },
      { tabId, link }
    )
  await expect.poll(readPoint, { message: `terminal link ${link} never rendered` }).not.toBeNull()
  const point = await readPoint()
  if (!point) {
    throw new Error(`terminal link ${link} disappeared before activation`)
  }
  return point
}

/** Prints origin+path as one link; split apart so the typed command never shows the whole URL. */
async function printLink(page: Page, tabId: string, origin: string, path: string): Promise<void> {
  // Why the blank row: a link opened beside the terminal narrows it, and a URL that exactly fills a
  // row would read the prompt below as its edge-wrapped continuation.
  await typeInTerminal(page, tabId, `printf '%s%s\\n\\n' '${origin}' '${path}'`)
  await expectPaneText(page, tabId, `${origin}${path}`)
}

function browserTabUrls(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().browserTabsByWorktree[id] ?? []).map((tab) => tab.url),
    worktreeId
  )
}

function browserTabIdForUrl(page: Page, worktreeId: string, url: string): Promise<string | null> {
  return page.evaluate(
    ({ id, url }) =>
      (window.__store?.getState().browserTabsByWorktree[id] ?? []).find((tab) => tab.url === url)
        ?.id ?? null,
    { id: worktreeId, url }
  )
}

/** The opened page must be the visible browser surface and render the host's response. */
async function expectRenderedLink(page: Page, worktreeId: string, url: string): Promise<void> {
  await expect.poll(() => browserTabIdForUrl(page, worktreeId, url)).not.toBeNull()
  const tabId = await browserTabIdForUrl(page, worktreeId, url)
  const webview = page.locator(`[data-browser-overlay-tab-id="${tabId}"] webview`)
  await expect(webview).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      () =>
        webview.evaluate(async (guest: Electron.WebviewTag) => {
          try {
            return await guest.executeJavaScript('document.querySelector("#marker")?.textContent')
          } catch {
            return null
          }
        }),
      { timeout: 60_000, message: 'the opened page never rendered the host response' }
    )
    .toMatch(/^cookie:/)
}

test('a managed SSH terminal link opens in the Orca Browser through the SSH host', async (// oxlint-disable-next-line no-empty-pattern -- Owns app launch.
{}, testInfo) => {
  test.setTimeout(5 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    startSshRemoteOnlyBrowserFixture(target)
    // The first launch only creates the profile the SSH host is saved into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(first.app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `orcad terminal link E2E ${Date.now()}`,
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      },
      { repoPath: DOCKER_SSH_HOST_REMOTE_REPO_PATH, folderPath: '/tmp' }
    )
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    await convertAndRetain(page, session.userDataDir, seeded)
    const environmentId = await managedEnvironmentId(page, seeded.targetId)
    await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
    await page.evaluate(() =>
      window.__store?.getState().updateSettings({
        openLinksInApp: true,
        terminalLinkClickBehavior: 'actions'
      })
    )
    const tabId = await openTerminalTab(page, seeded.worktreeId)

    // The link action popover offers the Orca Browser for a managed server's pane.
    const popoverUrl = `${SSH_REMOTE_ONLY_ORIGIN}/echo/popover`
    await printLink(page, tabId, SSH_REMOTE_ONLY_ORIGIN, '/echo/popover')
    const popoverPoint = await terminalLinkPoint(page, tabId, popoverUrl)
    await page.mouse.move(popoverPoint.x, popoverPoint.y)
    await page.mouse.click(popoverPoint.x, popoverPoint.y)
    const popover = page.locator('[data-terminal-link-action-popover]')
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('button').filter({ hasText: 'System Browser' })).toBeVisible()
    const orcaBrowser = popover.getByRole('button').filter({ hasText: 'Orca Browser' })
    await expect(orcaBrowser).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('managed-terminal-link-popover.png') })
    await orcaBrowser.click()
    await expect
      .poll(() => browserTabUrls(page, seeded.worktreeId), { timeout: 30_000 })
      .toContain(popoverUrl)
    // Only the SSH host resolves this origin, so the request proves the page egressed there.
    await expect
      .poll(() => readSshRemoteOnlyRequests(target).map((request) => request.path), {
        timeout: 60_000,
        message: 'the Orca Browser page never reached the SSH host'
      })
      .toContain('/echo/popover')
    await expectRenderedLink(page, seeded.worktreeId, popoverUrl)

    // Cmd/Ctrl-click opens a remote localhost dev-server URL straight into the Orca Browser.
    const modifierUrl = `http://localhost:${SSH_REMOTE_ONLY_PORT}/echo/modifier`
    await printLink(page, tabId, `http://localhost:${SSH_REMOTE_ONLY_PORT}`, '/echo/modifier')
    const modifierPoint = await terminalLinkPoint(page, tabId, modifierUrl)
    await page.mouse.move(modifierPoint.x, modifierPoint.y)
    await page.keyboard.down('ControlOrMeta')
    await page.mouse.click(modifierPoint.x, modifierPoint.y)
    await page.keyboard.up('ControlOrMeta')
    await expect
      .poll(() => browserTabUrls(page, seeded.worktreeId), { timeout: 30_000 })
      .toContain(modifierUrl)
    await expect
      .poll(() => readSshRemoteOnlyRequests(target).map((request) => request.path), {
        timeout: 60_000,
        message: 'the Cmd/Ctrl-clicked localhost link never reached the SSH host'
      })
      .toContain('/echo/modifier')
    await expectRenderedLink(page, seeded.worktreeId, modifierUrl)
    await page.screenshot({ path: testInfo.outputPath('managed-terminal-link-opened.png') })
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    } finally {
      cleanupDockerSshHostTarget(target)
    }
  }
})
