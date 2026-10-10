import { cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  startSshRemoteOnlyBrowserFixture,
  readSshRemoteOnlyRequests,
  SSH_REMOTE_ONLY_ORIGIN,
  SSH_REMOTE_ONLY_COOKIE_NAME,
  SSH_REMOTE_ONLY_COOKIE_VALUE
} from './helpers/ssh-remote-only-browser-fixture'
import { createRetentionFixtureDirectory } from './helpers/host-created-terminal-retention-oracle'
import { managedServer, reconnect } from './helpers/orcad-convert-flow'
import { navigateGuest } from './helpers/browser-split-guest-probes'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

async function guestMarker(page: Page, tabId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const guest = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${id}"] webview`
    )
    try {
      return await guest?.executeJavaScript('document.querySelector("#marker")?.textContent')
    } catch {
      return null
    }
  }, tabId)
}

test('retained and new browser tabs keep SSH routing and login cookies after managed conversion', async (// oxlint-disable-next-line no-empty-pattern -- Owns app launch.
{}, testInfo) => {
  test.setTimeout(5 * 60_000)
  const target = startDockerSshRelayTarget(testInfo)
  const scratch = createRetentionFixtureDirectory()
  const template = path.join(scratch, 'template')
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: template })
  let app: ElectronApplication | null = null
  try {
    startSshRemoteOnlyBrowserFixture(target)
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    const remote = await connectDockerSshRelayTarget(page, target, { seedInitialTab: false })
    expect(await managedServer(page, remote.targetId)).toMatchObject({ kind: 'relay' })
    const tabId = await page.evaluate(
      ({ worktreeId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing store')
        }
        const tab = state.createBrowserTab(worktreeId, url, {
          title: 'Retained browser',
          activate: true
        })
        for (const terminal of state.tabsByWorktree[worktreeId] ?? []) {
          state.closeTab(terminal.id)
        }
        return tab.id
      },
      { worktreeId: remote.worktreeId, url: `${SSH_REMOTE_ONLY_ORIGIN}/login` }
    )
    await expect.poll(() => guestMarker(page, tabId), { timeout: 60_000 }).toBe('login-marker')
    await navigateGuest(page, tabId, `${SSH_REMOTE_ONLY_ORIGIN}/echo/before`)
    const cookieMarker = `cookie:${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    await expect.poll(() => guestMarker(page, tabId), { timeout: 30_000 }).toBe(cookieMarker)
    await page.screenshot({ path: testInfo.outputPath('browser-before-conversion.png') })
    const partitionBefore = await page
      .locator(`[data-browser-overlay-tab-id="${tabId}"] webview`)
      .getAttribute('partition')
    expect(partitionBefore).toMatch(/^persist:/)
    await expect
      .poll(
        () =>
          page.evaluate((id) => window.api.pty.listSessions({ connectionId: id }), remote.targetId),
        { timeout: 30_000 }
      )
      .toEqual([])
    cpSync(TEMPLATE!, template, { recursive: true })
    const server = await reconnect(page, remote.targetId)
    console.log('[browser-conversion-connect]', server)
    expect(JSON.parse(server)).toMatchObject({ kind: 'managed' })
    const environments = await page.evaluate(() => window.api.runtimeEnvironments.list())
    const environment = environments.find(
      (entry) => entry.orcadDeployment?.sshTargetId === remote.targetId
    )
    if (!environment) {
      throw new Error('Missing managed environment')
    }
    await expect
      .poll(
        () =>
          page.evaluate((worktreeId) => {
            const state = window.__store?.getState()
            return (
              state?.repos.find((repo) =>
                (state.worktreesByRepo[repo.id] ?? []).some(
                  (worktree) => worktree.id === worktreeId
                )
              )?.executionHostId ?? null
            )
          }, remote.worktreeId),
        { timeout: 60_000 }
      )
      .toMatch(/^runtime:/)
    const retained = await page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const tab = state?.browserTabsByWorktree[worktreeId]?.[0]
      const repo = state?.repos.find((repo) =>
        (state.worktreesByRepo[repo.id] ?? []).some((worktree) => worktree.id === worktreeId)
      )
      if (repo?.executionHostId) {
        state?.setActiveWorktree(worktreeId, repo.executionHostId)
      }
      if (tab?.activePageId) {
        state?.focusBrowserTabInWorktree(worktreeId, tab.activePageId, { surfacePane: true })
      }
      return tab?.id ?? null
    }, remote.worktreeId)
    expect(retained).toBe(tabId)
    await expect.poll(() => guestMarker(page, tabId), { timeout: 30_000 }).toBe(cookieMarker)
    await navigateGuest(page, tabId, `${SSH_REMOTE_ONLY_ORIGIN}/echo/retained`)
    await expect.poll(() => guestMarker(page, tabId), { timeout: 30_000 }).toBe(cookieMarker)
    expect(readSshRemoteOnlyRequests(target)).toContainEqual({
      path: '/echo/retained',
      cookie: `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    })
    expect(
      await page
        .locator(`[data-browser-overlay-tab-id="${tabId}"] webview`)
        .getAttribute('partition')
    ).toBe(partitionBefore)
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('browser-retained-after-conversion.png') })
    await page.evaluate(
      async ({ worktreeId, url }) => {
        const state = window.__store?.getState()
        const groupId = state?.activeGroupIdByWorktree[worktreeId]
        if (!state || !groupId) {
          throw new Error('No active browser group')
        }
        state.setBrowserDefaultUrl(url)
        await state.openNewBrowserTabInActiveWorkspace(groupId)
      },
      { worktreeId: remote.worktreeId, url: `${SSH_REMOTE_ONLY_ORIGIN}/echo/control` }
    )
    await expect
      .poll(
        () => readSshRemoteOnlyRequests(target).some((request) => request.path === '/echo/control'),
        { timeout: 60_000 }
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('browser-new-tab-control.png') })
    const createdId = await page.evaluate(
      ({ worktreeId, retainedId }) => {
        const created = window.__store
          ?.getState()
          .browserTabsByWorktree[worktreeId]?.find((tab) => tab.id !== retainedId)
        if (!created) {
          throw new Error('Missing new browser tab')
        }
        return created.id
      },
      { worktreeId: remote.worktreeId, retainedId: tabId }
    )
    await expect.poll(() => guestMarker(page, createdId), { timeout: 30_000 }).toBe(cookieMarker)
    const partitionAfter = await page
      .locator(`[data-browser-overlay-tab-id="${createdId}"] webview`)
      .getAttribute('partition')
    expect(partitionAfter).toBe(partitionBefore)
    expect(readSshRemoteOnlyRequests(target)).toContainEqual({
      path: '/echo/control',
      cookie: `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    })
    const generation = environment.orcadDeployment?.sshTargetGeneration
    if (generation === undefined) {
      throw new Error('Missing deployment registration')
    }
    const stale = await page.evaluate(
      async (args) => {
        try {
          await window.api.browser.prepareSshWorkspacePartition(args)
          return 'accepted'
        } catch (error) {
          return String(error)
        }
      },
      { targetId: remote.targetId, expectedSshTargetGeneration: generation + 1 }
    )
    expect(stale).toContain('browser_local_route_target_stale')
    await reconnect(page, remote.targetId)
    await navigateGuest(page, createdId, `${SSH_REMOTE_ONLY_ORIGIN}/echo/reconnect`)
    await expect.poll(() => guestMarker(page, createdId), { timeout: 30_000 }).toBe(cookieMarker)
    expect(readSshRemoteOnlyRequests(target)).toContainEqual({
      path: '/echo/reconnect',
      cookie: `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    })
    await page.evaluate(
      ({ worktreeId, tabId }) => {
        const state = window.__store?.getState()
        const pageId = state?.browserTabsByWorktree[worktreeId]?.find(
          (tab) => tab.id === tabId
        )?.activePageId
        if (pageId) {
          state?.focusBrowserTabInWorktree(worktreeId, pageId, { surfacePane: true })
        }
      },
      { worktreeId: remote.worktreeId, tabId }
    )
    await navigateGuest(page, tabId, `${SSH_REMOTE_ONLY_ORIGIN}/echo/retained-reconnect`)
    await expect.poll(() => guestMarker(page, tabId), { timeout: 30_000 }).toBe(cookieMarker)
    expect(readSshRemoteOnlyRequests(target)).toContainEqual({
      path: '/echo/retained-reconnect',
      cookie: `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    })
    console.log(
      '[managed-browser-route]',
      JSON.stringify({
        partitionBefore,
        partitionAfter,
        requests: readSshRemoteOnlyRequests(target)
      })
    )
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('browser-retained-after-reconnect.png') })
    await session.close(app)
    app = null
    const restarted = await session.launch()
    app = restarted.app
    await waitForSessionReady(restarted.page)
    await waitForStartupWorktreeRefresh(restarted.page)
    console.log(
      '[retained-browser-restored]',
      JSON.stringify(
        await restarted.page.evaluate(() => {
          const state = window.__store?.getState()
          return {
            tabs: state?.browserTabsByWorktree,
            pages: state?.browserPagesByWorkspace,
            active: state?.activeWorktreeId,
            host: state?.activeWorkspaceExecutionHostId
          }
        })
      )
    )
    await restarted.page.evaluate(
      ({ worktreeId, environmentId, tabId }) => {
        const state = window.__store?.getState()
        state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        const pageId = state?.browserTabsByWorktree[worktreeId]?.find(
          (tab) => tab.id === tabId
        )?.activePageId
        if (pageId) {
          state?.focusBrowserTabInWorktree(worktreeId, pageId, { surfacePane: true })
        }
      },
      { worktreeId: remote.worktreeId, environmentId: environment.id, tabId }
    )
    await expect
      .poll(() => guestMarker(restarted.page, tabId), { timeout: 60_000 })
      .toBe(cookieMarker)
    await navigateGuest(restarted.page, tabId, `${SSH_REMOTE_ONLY_ORIGIN}/echo/retained-restart`)
    expect(readSshRemoteOnlyRequests(target)).toContainEqual({
      path: '/echo/retained-restart',
      cookie: `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    })
    console.log('[retained-browser-restart]', JSON.stringify(readSshRemoteOnlyRequests(target)))
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshRelayTarget(target)
    rmSync(scratch, { recursive: true, force: true })
  }
})
