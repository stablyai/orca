import { cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  startSshRemoteOnlyBrowserFixture,
  SSH_REMOTE_ONLY_ORIGIN,
  SSH_REMOTE_ONLY_COOKIE_NAME,
  SSH_REMOTE_ONLY_COOKIE_VALUE
} from './helpers/ssh-remote-only-browser-fixture'
import { createRetentionFixtureDirectory } from './helpers/host-created-terminal-retention-oracle'
import { managedServer, reconnect, serverCall } from './helpers/orcad-convert-flow'
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

test('an unavailable browser on a responding managed host does not report a server outage', async (// oxlint-disable-next-line no-empty-pattern -- Owns app launch.
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
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        console.log('[browser-renderer]', message.text().slice(0, 1_000))
      }
    })
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
    console.log('[browser-host-status]', await serverCall(page, environment.id, 'status.get'))
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
    // Retained desktop pages stay local after conversion; place this one on the managed host.
    const remoteTabId = await page.evaluate(
      ({ worktreeId, environmentId, url }) => {
        const state = window.__store?.getState()
        const repo = state?.repos.find((repo) =>
          (state.worktreesByRepo[repo.id] ?? []).some((worktree) => worktree.id === worktreeId)
        )
        if (!state || !repo?.executionHostId) {
          throw new Error('Missing converted workspace')
        }
        state.setActiveWorktree(worktreeId, repo.executionHostId)
        const tab = state.createBrowserTab(worktreeId, url, {
          title: 'Managed host browser',
          activate: true,
          browserRuntimeEnvironmentId: environmentId
        })
        if (tab.activePageId) {
          state.focusBrowserTabInWorktree(worktreeId, tab.activePageId, { surfacePane: true })
        }
        return tab.id
      },
      {
        worktreeId: remote.worktreeId,
        environmentId: environment.id,
        url: `${SSH_REMOTE_ONLY_ORIGIN}/login`
      }
    )
    expect(remoteTabId).not.toBe(tabId)
    const notice = page.getByTestId('remote-browser-stream-error')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath('browser-service-status.png') })
    console.log('[browser-service-notice]', await notice.innerText())
    const browserReply = await page.evaluate(
      (environmentId) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'browser.tabList',
          params: {}
        }),
      environment.id
    )
    expect(browserReply).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } })
    console.log('[browser-service-refusal]', JSON.stringify(browserReply))
    const catalog = JSON.parse(await serverCall(page, environment.id, 'repo.list'))
    console.log('[browser-service-responsive-host]', JSON.stringify(catalog))
    expect(catalog).toMatchObject({
      ok: true,
      result: { repos: expect.arrayContaining([expect.objectContaining({ id: remote.repoId })]) }
    })
    await expect(notice).toContainText(
      'The remote browser is unavailable. Check its setup on the server.'
    )
    await expect(notice).not.toContainText('Cannot reach the remote server.')
    // Why: the managed host can mirror a terminal it seeds for this workspace, taking focus.
    await expect(async () => {
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
        { worktreeId: remote.worktreeId, tabId: remoteTabId }
      )
      await notice.getByRole('button', { name: 'Reconnect', exact: true }).click({ timeout: 2_000 })
      await expect(notice).toContainText(
        'The remote browser is unavailable. Check its setup on the server.',
        { timeout: 2_000 }
      )
    }).toPass({ timeout: 30_000 })
    console.log('[browser-service-after-retry]', await notice.innerText())
    expect(JSON.parse(await serverCall(page, environment.id, 'repo.list'))).toMatchObject({
      ok: true,
      result: { repos: expect.arrayContaining([expect.objectContaining({ id: remote.repoId })]) }
    })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshRelayTarget(target)
    rmSync(scratch, { recursive: true, force: true })
  }
})
