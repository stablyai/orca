import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'

import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './helpers/electron-home-isolation'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'

const PACKAGED_EXECUTABLE_ENV = 'ORCA_CROSS_VERSION_PACKAGED_EXECUTABLE'
const CLIENT_HOST_CAPABILITY = 'browser.clientHost.v1'
const TUNNEL_CAPABILITY = 'network.browserTunnel.v1'

type BrowserFixture = {
  close(): Promise<void>
  url: string
}

type PackagedPairedClient = {
  app: ElectronApplication
  environmentId: string
  page: Page
  status: { capabilities: string[] }
  version: string
  dispose(): Promise<void>
}

type BrowserCreateResult = {
  browserPageId: string
}

type PackagedPlacementCleanup = () => Promise<void> | void

async function collectCleanupFailures(cleanups: PackagedPlacementCleanup[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

async function withPackagedPlacementCleanup(
  run: (registerCleanup: (cleanup: PackagedPlacementCleanup) => void) => Promise<void>
): Promise<void> {
  const cleanups: PackagedPlacementCleanup[] = []
  let testError: unknown
  try {
    await run((cleanup) => cleanups.unshift(cleanup))
  } catch (error) {
    testError = error
  }
  const cleanupErrors = await collectCleanupFailures(cleanups)
  if (testError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([testError, ...cleanupErrors], 'Placement test and cleanup failed')
  }
  if (testError !== undefined) {
    throw testError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Packaged placement cleanup failed')
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function startBrowserFixture(): Promise<BrowserFixture> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(
      '<!doctype html><html><body><h1 id="marker">packaged-skew-marker</h1></body></html>'
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    close: () => closeServer(server),
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/browser`
  }
}

async function readOwnedPageUrls(app: ElectronApplication, url: string): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .map((contents) => contents.getURL())
        .filter((candidate) => candidate.startsWith(prefix)),
    url
  )
}

async function removeProfile(userDataDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

async function launchPackagedPairedClient(args: {
  executablePath: string
  offer: RuntimeDesktopPairingOffer
  testInfo: TestInfo
}): Promise<PackagedPairedClient> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-packaged-client-'))
  let app: ElectronApplication | undefined
  try {
    writeFileSync(
      path.join(userDataDir, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    const homeIsolation = createElectronHomeIsolation({
      inheritedEnv: cleanEnv,
      launchEnv: {},
      extraEnv: {},
      userDataDir
    })
    app = await electron.launch({
      executablePath: args.executablePath,
      args: [],
      env: {
        ...homeIsolation.env,
        NODE_ENV: 'production',
        ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1',
        ORCA_E2E_HEADLESS: '1'
      }
    })
    forwardElectronProcessLogs(app, args.testInfo)
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      homeIsolation
    )
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    const [status, version, environmentId] = await Promise.all([
      page.evaluate(() => window.api.runtime.getStatus()),
      app.evaluate(({ app: electronApp }) => electronApp.getVersion()),
      page.evaluate(async ({ pairingUrl }) => {
        const result = await window.api.runtimeEnvironments.addFromPairingCode({
          name: 'STA-4150 packaged old client',
          pairingCode: pairingUrl
        })
        const response = await window.api.runtimeEnvironments.getStatus({
          selector: result.environment.id,
          timeoutMs: 30_000
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        return result.environment.id
      }, args.offer)
    ])
    return {
      app,
      environmentId,
      page,
      status,
      version,
      dispose: async () => {
        const failures = await collectCleanupFailures([
          () => closeElectronAppForE2E(app!),
          () => cleanupE2EDaemons(userDataDir),
          () => removeProfile(userDataDir)
        ])
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Failed to clean up packaged paired client')
        }
      }
    }
  } catch (error) {
    const cleanupErrors = await collectCleanupFailures([
      ...(app ? [() => closeElectronAppForE2E(app)] : []),
      () => cleanupE2EDaemons(userDataDir),
      () => removeProfile(userDataDir)
    ])
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Packaged client startup and cleanup failed'
      )
    }
    throw error
  }
}

async function createBrowserThroughPackagedClient(args: {
  client: PackagedPairedClient
  url: string
  worktreePath: string
}): Promise<BrowserCreateResult> {
  return args.client.page.evaluate(
    async ({ environmentId, url, worktreePath }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'browser.tabCreate',
        params: {
          activate: true,
          url,
          waitForRegistration: true,
          worktree: `path:${worktreePath}`
        },
        timeoutMs: 60_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result as BrowserCreateResult
    },
    {
      environmentId: args.client.environmentId,
      url: args.url,
      worktreePath: args.worktreePath
    }
  )
}

async function readRemoteSnapshot(args: {
  environmentId: string
  page: Page
  pageId: string
  worktreePath: string
}): Promise<string> {
  return args.page.evaluate(
    async ({ environmentId, pageId, worktreePath }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'browser.snapshot',
        params: { page: pageId, worktree: `path:${worktreePath}` },
        timeoutMs: 30_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return (response.result as { snapshot: string }).snapshot
    },
    {
      environmentId: args.environmentId,
      pageId: args.pageId,
      worktreePath: args.worktreePath
    }
  )
}

async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (candidatePath) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === candidatePath)?.id ?? null,
          repoPath
        ),
      { timeout: 60_000 }
    )
    .not.toBeNull()
  const worktreeId = await page.evaluate(
    (candidatePath) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.path === candidatePath)?.id ?? null,
    repoPath
  )
  if (!worktreeId) {
    throw new Error('Paired worktree disappeared after discovery')
  }
  return worktreeId
}

async function createBrowserThroughCurrentClient(args: {
  client: PairedElectronClient
  url: string
  worktreeId: string
}): Promise<{ localPageId: string; remotePageId: string }> {
  await args.client.page.evaluate(
    async ({ environmentId, url, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Current client store is unavailable')
      }
      state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      const groupId = state.activeGroupIdByWorktree[worktreeId]
      if (!groupId) {
        throw new Error('Current client has no active tab group')
      }
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(groupId)
    },
    { environmentId: args.client.environmentId, url: args.url, worktreeId: args.worktreeId }
  )
  await expect
    .poll(
      () =>
        args.client.page.evaluate(
          ({ url, worktreeId }) => {
            const state = window.__store?.getState()
            for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
              for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
                if (!browserPage.url.startsWith(url)) {
                  continue
                }
                const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
                return {
                  localPageId: browserPage.id,
                  placementKind: handle?.placement?.kind ?? null,
                  remotePageId: handle?.remotePageId ?? browserPage.id
                }
              }
            }
            return null
          },
          { url: args.url, worktreeId: args.worktreeId }
        ),
      { timeout: 60_000 }
    )
    .toMatchObject({ placementKind: null })
  const mirrored = await args.client.page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (browserPage.url.startsWith(url)) {
            const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
            return {
              localPageId: browserPage.id,
              remotePageId: handle?.remotePageId ?? browserPage.id
            }
          }
        }
      }
      return null
    },
    { url: args.url, worktreeId: args.worktreeId }
  )
  if (!mirrored) {
    throw new Error('Server-hosted browser page disappeared after materialization')
  }
  return mirrored
}

const packagedExecutable = process.env[PACKAGED_EXECUTABLE_ENV]

test.describe('packaged mixed-version browser placement', () => {
  test.skip(
    !packagedExecutable || !existsSync(packagedExecutable),
    `${PACKAGED_EXECUTABLE_ENV} must point at an older packaged Orca executable`
  )

  test('keeps an old packaged client on the current server-hosted path', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    await withPackagedPlacementCleanup(async (registerCleanup) => {
      const host = await launchHeadlessPairedRuntimeHost()
      registerCleanup(() => host.dispose())
      const fixture = await startBrowserFixture()
      registerCleanup(() => fixture.close())
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      const client = await launchPackagedPairedClient({
        executablePath: packagedExecutable!,
        offer: host.offer,
        testInfo
      })
      registerCleanup(() => client.dispose())
      expect(client.status.capabilities).not.toContain(CLIENT_HOST_CAPABILITY)
      expect(client.status.capabilities).not.toContain(TUNNEL_CAPABILITY)

      const created = await createBrowserThroughPackagedClient({
        client,
        url: fixture.url,
        worktreePath: testRepoPath
      })
      await expect.poll(() => readOwnedPageUrls(host.app, fixture.url)).toHaveLength(1)
      expect(await readOwnedPageUrls(client.app, fixture.url)).toHaveLength(0)
      expect(
        await readRemoteSnapshot({
          environmentId: client.environmentId,
          page: client.page,
          pageId: created.browserPageId,
          worktreePath: testRepoPath
        })
      ).toContain('packaged-skew-marker')
      expect(client.version).toMatch(/^1\./)
    })
  })

  test('keeps a current client on an old packaged server-hosted path', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    await withPackagedPlacementCleanup(async (registerCleanup) => {
      const host = await launchHeadlessPairedRuntimeHost({
        executablePath: packagedExecutable!,
        // Why: the old macOS helper has a 103-byte Unix socket ceiling.
        ...(process.platform === 'darwin'
          ? { agentBrowserSocketParent: '/tmp', userDataParent: '/tmp' }
          : {})
      })
      registerCleanup(() => host.dispose())
      const fixture = await startBrowserFixture()
      registerCleanup(() => fixture.close())
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      await host.client.call('terminal.create', {
        worktree: `path:${testRepoPath}`,
        title: 'Packaged mixed-version browser canary'
      })
      const client: PairedElectronClient = await launchPairedElectronClient(
        host.offer,
        testInfo,
        'STA-4150 current client to packaged old host'
      )
      registerCleanup(() => client.dispose())
      const status = await client.page.evaluate(async (environmentId) => {
        const response = await window.api.runtimeEnvironments.getStatus({
          selector: environmentId,
          timeoutMs: 30_000
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        return response.result
      }, client.environmentId)
      expect(status.capabilities).not.toContain(CLIENT_HOST_CAPABILITY)
      expect(status.capabilities).not.toContain(TUNNEL_CAPABILITY)

      const worktreeId = await findPairedWorktreeId(client.page, testRepoPath)
      const created = await createBrowserThroughCurrentClient({
        client,
        url: fixture.url,
        worktreeId
      })
      await client.page.evaluate(
        ({ localPageId, worktreeId }) =>
          window.__store?.getState().focusBrowserTabInWorktree(worktreeId, localPageId, {
            surfacePane: true
          }),
        { localPageId: created.localPageId, worktreeId }
      )
      await expect(client.page.getByTestId('remote-browser-frame').first()).toBeVisible({
        timeout: 60_000
      })
      await expect.poll(() => readOwnedPageUrls(host.app, fixture.url)).toHaveLength(1)
      expect(await readOwnedPageUrls(client.app, fixture.url)).toHaveLength(0)
      expect(
        await readRemoteSnapshot({
          environmentId: client.environmentId,
          page: client.page,
          pageId: created.remotePageId,
          worktreePath: testRepoPath
        })
      ).toContain('packaged-skew-marker')
    })
  })
})
