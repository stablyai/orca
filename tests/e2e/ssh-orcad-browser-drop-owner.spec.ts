import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { openFileExplorer } from './helpers/file-explorer'
import { shellQuote } from './helpers/docker-ssh-relay-target'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'
import {
  navigateGuest,
  waitForGuestUrl,
  waitForGuestIdle
} from './helpers/browser-split-guest-probes'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { getWorktreeHostIdentity } from '../../src/shared/worktree/host-qualified-identity'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs owned Docker host')
test.skip(process.platform === 'win32', 'Owned POSIX host collision fixture')

async function dropExplorerFile(page: Page, name: string, tabId: string) {
  const row = page.locator('[data-file-explorer-row]').filter({ hasText: name })
  await expect(row).toBeVisible()
  return row.evaluate((element, browserTabId) => {
    const webview = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${browserTabId}"] webview`
    )
    if (!webview || !webview.parentElement) {
      throw new Error('Missing actual guest container')
    }
    const dataTransfer = new DataTransfer()
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    const payload = Object.fromEntries(
      [...dataTransfer.types].map((type) => [type, dataTransfer.getData(type)])
    )
    const rect = webview.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      throw new Error('Actual guest has no drop surface')
    }
    webview.parentElement.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      })
    )
    element.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    return payload
  }, tabId)
}

async function guestText(page: Page, tabId: string) {
  return page.evaluate(async (id) => {
    const webview = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${id}"] webview`
    )
    if (!webview) {
      throw new Error('Missing actual guest')
    }
    return {
      url: webview.getURL(),
      text: await webview.executeJavaScript('document.body.innerText')
    }
  }, tabId)
}

test('managed Files drag cannot load a desktop same-path HTML file', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const fileName = 'DROP_OWNER.html'
  const filePath = path.join(testRepoPath, fileName)
  writeFileSync(filePath, '<html><body>DESKTOP_BROWSER_DROP_OWNER</body></html>')
  const host = startOrcadConvertHost('docker', testInfo)
  const server = await startBrowserSplitPageServer()
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    if (!host.exec) {
      throw new Error('Missing owned host control')
    }
    host.exec(
      `mkdir -p ${shellQuote(path.dirname(testRepoPath))} && git clone --quiet ${shellQuote(host.remoteRepoPath)} ${shellQuote(testRepoPath)} && printf '%s' '<html><body>REMOTE_BROWSER_DROP_OWNER</body></html>' > ${shellQuote(filePath)}`
    )
    host.exec(
      `printf '%s' REMOTE_DROP_READY > ${shellQuote(path.join(testRepoPath, 'REMOTE_DROP_READY.txt'))}`
    )
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const nativeId = await first.page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return `${result.repo.id}::${repoPath}`
    }, testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: testRepoPath,
      folderPath: host.remoteFolderPath
    })
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    await convertAndRetain(page, session.userDataDir, seeded)
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment) {
      throw new Error('Missing actual managed environment')
    }
    await dismissTransientAnnouncement(page)
    const nativeIdentity = getWorktreeHostIdentity({ id: nativeId, hostId: 'local' })
    await page.locator(`[data-worktree-host-identity="${nativeIdentity}"]:visible`).click()
    await openFileExplorer(page)
    const floatingId = await page.evaluate(
      (url) => {
        const store = window.__store
        const state = store?.getState()
        if (!store || !state?.settings) {
          throw new Error('Missing ready settings')
        }
        store.setState({ settings: { ...state.settings, floatingTerminalEnabled: true } })
        const tab = store.getState().createBrowserTab('global-floating-terminal', url, {
          activate: true,
          focusAddressBar: false,
          targetGroupId: state.ensureWorktreeRootGroup('global-floating-terminal'),
          browserRuntimeEnvironmentId: null
        })
        return tab.id
      },
      server.pageUrl('float', 1)
    )
    await expect(page.locator('[data-floating-terminal-panel]')).toHaveCount(1)
    if ((await page.locator('[data-floating-terminal-panel][aria-hidden="false"]').count()) === 0) {
      await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
    }
    await expect(page.locator(`[data-browser-overlay-tab-id="${floatingId}"]`)).toBeVisible()
    await waitForGuestUrl(page, floatingId, server.pageUrl('float', 1))
    console.log('[native-actual-drag-payload]', await dropExplorerFile(page, fileName, floatingId))
    await expect
      .poll(async () => (await guestText(page, floatingId)).text)
      .toContain('DESKTOP_BROWSER_DROP_OWNER')
    console.log('[native-positive-actual-guest]', await guestText(page, floatingId))
    await navigateGuest(page, floatingId, server.pageUrl('float', 2))
    await waitForGuestIdle(page, floatingId)
    const remoteIdentity = getWorktreeHostIdentity({
      id: seeded.worktreeId,
      hostId: toRuntimeExecutionHostId(environment.id)
    })
    await page.locator(`[data-worktree-host-identity="${remoteIdentity}"]:visible`).click()
    await openFileExplorer(page)
    await page.getByRole('button', { name: 'Refresh Explorer', exact: true }).click()
    await expect(
      page.locator('[data-file-explorer-row]').filter({ hasText: 'REMOTE_DROP_READY.txt' })
    ).toBeVisible()
    expect(
      await page.evaluate(() => window.__store?.getState().activeWorkspaceExecutionHostId)
    ).toBe(toRuntimeExecutionHostId(environment.id))
    console.log(
      '[independent-managed-source]',
      await serverCall(page, environment.id, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: fileName
      })
    )
    const remotePayload = await dropExplorerFile(page, fileName, floatingId)
    console.log('[managed-actual-drag-payload]', remotePayload)
    expect(
      JSON.parse(remotePayload['application/x-orca-workspace-file-source'] ?? '{}')
    ).toMatchObject({
      executionHostId: toRuntimeExecutionHostId(environment.id),
      workspaceId: seeded.worktreeId
    })
    await waitForGuestIdle(page, floatingId)
    console.log('[managed-drop-actual-guest]', await guestText(page, floatingId))
    await page.screenshot({ path: testInfo.outputPath('managed-browser-drop-owner.png') })
    expect((await guestText(page, floatingId)).text).not.toContain('DESKTOP_BROWSER_DROP_OWNER')
    await expect(
      page.getByText('Open in Orca Browser is only available for local files.', { exact: true })
    ).toBeVisible()
    expect((await guestText(page, floatingId)).url).toBe(server.pageUrl('float', 2))
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
      await server.close()
    } finally {
      host.cleanup()
    }
  }
})
