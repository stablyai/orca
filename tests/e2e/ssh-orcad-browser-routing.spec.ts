import { cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  startDockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import {
  startSshRemoteOnlyBrowserFixture,
  readSshRemoteOnlyRequests,
  SSH_REMOTE_ONLY_ORIGIN,
  SSH_REMOTE_ONLY_COOKIE_NAME,
  SSH_REMOTE_ONLY_COOKIE_VALUE
} from './helpers/ssh-remote-only-browser-fixture'
import { createRetentionFixtureDirectory } from './helpers/host-created-terminal-retention-oracle'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { deriveBrowserRoutePartition } from '../../src/main/browser/browser-route-identity'
import { sshExecutionHostStorageIdentity } from '../../src/main/browser/browser-execution-host-storage-identity'
import { reconnect } from './helpers/orcad-convert-flow'
import { navigateGuest } from './helpers/browser-split-guest-probes'
import { ORCAD_TEMPLATE, skipUnlessManagedDockerHost } from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

/** The partition a relay-era build kept this host's browser storage in (local-ssh-browser-partitions). */
function relayEraPartition(targetId: string): string {
  return deriveBrowserRoutePartition({
    orcaProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
    browserProfileId: 'default',
    authorityConnectionIdentity: JSON.stringify([
      'orca-local-ssh-browser',
      1,
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    ]),
    executionHostIdentity: sshExecutionHostStorageIdentity(targetId)
  }).partition
}

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
        label: `orcad browser routing E2E ${Date.now()}`,
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
    // The browser tab a relay-era build left open on the saved host, never connected this launch.
    const tabId = await page.evaluate(
      ({ worktreeId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing store')
        }
        // Not shown yet: it mounts once the user opens it after upgrading.
        return state.createBrowserTab(worktreeId, url, {
          title: 'Retained browser',
          activate: false
        }).id
      },
      { worktreeId: remote.worktreeId, url: `${SSH_REMOTE_ONLY_ORIGIN}/login` }
    )
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ hostId, tabId }) =>
              JSON.stringify(await window.api.session.get(hostId)).includes(tabId),
            { hostId: toSshExecutionHostId(remote.targetId), tabId }
          ),
        { timeout: 30_000, message: 'the retained browser tab never reached the host session' }
      )
      .toBe(true)
    const cookieMarker = `cookie:${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
    // The login cookie a relay-era session left in that host's browser storage.
    const partitionBefore = relayEraPartition(remote.targetId)
    // A relay-era build bound the partition before any page stored a cookie in it; unbound
    // partition data is refused as browser_route_partition_binding_store_invalid.
    const bound = await page.evaluate(
      (targetId) =>
        window.api.browser.prepareSshWorkspacePartition({
          targetId,
          browserProfileId: 'default',
          skipProbe: true
        }),
      remote.targetId
    )
    expect(bound.partition).toBe(partitionBefore)
    await app.evaluate(
      async ({ session }, cookie) => {
        const jar = session.fromPartition(cookie.partition).cookies
        await jar.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          expirationDate: Math.floor(Date.now() / 1000) + 3600
        })
        await jar.flushStore()
      },
      {
        partition: partitionBefore,
        url: `${SSH_REMOTE_ONLY_ORIGIN}/`,
        name: SSH_REMOTE_ONLY_COOKIE_NAME,
        value: SSH_REMOTE_ONLY_COOKIE_VALUE
      }
    )
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
    // The retained tab reaches the host and still sends the relay-era cookie, with no new login.
    await expect(async () => {
      // A page that mounted before the host connected offers Retry, as it would to the user.
      const retry = page.getByRole('button', { name: 'Retry', exact: true })
      if (await retry.isVisible()) {
        await retry.click()
      }
      await navigateGuest(page, tabId, `${SSH_REMOTE_ONLY_ORIGIN}/echo/retained`)
      expect(await guestMarker(page, tabId)).toBe(cookieMarker)
    }).toPass({ timeout: 60_000 })
    expect(
      await page
        .locator(`[data-browser-overlay-tab-id="${tabId}"] webview`)
        .getAttribute('partition')
    ).toBe(partitionBefore)
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
    cleanupDockerSshHostTarget(target)
    rmSync(scratch, { recursive: true, force: true })
  }
})
