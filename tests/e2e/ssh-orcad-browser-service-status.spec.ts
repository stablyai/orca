import { cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
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
  startSshRemoteOnlyBrowserFixture,
  SSH_REMOTE_ONLY_ORIGIN
} from './helpers/ssh-remote-only-browser-fixture'
import { createRetentionFixtureDirectory } from './helpers/host-created-terminal-retention-oracle'
import { reconnect, serverCall } from './helpers/orcad-convert-flow'
import { ORCAD_TEMPLATE, skipUnlessManagedDockerHost } from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

test('an unavailable browser on a responding managed host does not report a server outage', async (// oxlint-disable-next-line no-empty-pattern -- Owns app launch.
{}, testInfo) => {
  test.setTimeout(5 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const scratch = createRetentionFixtureDirectory()
  const template = path.join(scratch, 'template')
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: template })
  let app: ElectronApplication | null = null
  try {
    startSshRemoteOnlyBrowserFixture(target)
    // The first launch only creates the profile the relay-era host is saved into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(first.app)
    app = null
    const remote = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `orcad browser status E2E ${Date.now()}`,
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
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        console.log('[browser-renderer]', message.text().slice(0, 1_000))
      }
    })
    await waitForSessionReady(page)
    cpSync(ORCAD_TEMPLATE!, template, { recursive: true })
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
    // A browser placed on the managed host, which has no browser backend.
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
    cleanupDockerSshHostTarget(target)
    rmSync(scratch, { recursive: true, force: true })
  }
})
