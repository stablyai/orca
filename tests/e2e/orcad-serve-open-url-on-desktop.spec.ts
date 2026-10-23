/**
 * #30731: `orca open-url` on a paired `orca serve` running orcad with no browser engine opens the
 * page in the paired desktop's browser, its network routed through the server.
 *
 * Needs the packaged orcad slot (`pnpm build:orcad`). Background launch only; nothing is focused.
 *
 * Run:
 *   ORCA_E2E_ORCAD_SERVE=1 ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test \
 *     tests/e2e/orcad-serve-open-url-on-desktop.spec.ts --config tests/playwright.config.ts \
 *     --project electron-headless --workers=1
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'

import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { resolveBundledOrcadRuntime } from '../../src/main/orcad/orcad-bundled-runtime'
import { expect, test } from './helpers/orca-app'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import { cliServeProfile, spawnUntilReady } from './helpers/orca-serve-cli-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'

const RUN = process.env.ORCA_E2E_ORCAD_SERVE === '1'
const slotDir = path.resolve('out/orcad')
const orcadRuntime = RUN && existsSync(slotDir) ? resolveBundledOrcadRuntime(slotDir) : null
const MARKER = 'open-url-desktop-marker'

let scratch = ''

test.beforeAll(() => {
  test.skip(!RUN, 'Set ORCA_E2E_ORCAD_SERVE=1 (and build out/orcad) to run against orcad serve.')
  expect(orcadRuntime, 'pnpm build:orcad must produce a packaged slot in out/orcad').toBeTruthy()
  // Short root: macOS caps a unix socket path at 104 bytes, and the daemon's lives in userData.
  scratch = mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'orca-ou-'))
})

test.afterAll(() => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
  }
})

/** A page on the server's loopback, as an agent's dev server would be. */
async function startPageServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>${MARKER}</title><h1 id="marker">${MARKER}</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('page server has no TCP address')
  }
  return { url: `http://127.0.0.1:${address.port}/`, server }
}

/** The marker the desktop's own browser engine rendered for `url`, read from its guest. */
async function readDesktopPageMarker(
  app: ElectronApplication,
  url: string
): Promise<string | null> {
  return app.evaluate(async ({ webContents }, prefix) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getURL().startsWith(prefix)) {
        const marker: unknown = await contents
          .executeJavaScript('document.querySelector("#marker")?.textContent ?? null')
          .catch(() => null)
        return typeof marker === 'string' ? marker : null
      }
    }
    return null
  }, url)
}

test('orca open-url on orcad serve opens the page in the paired desktop', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const profile = cliServeProfile(scratch)
  const serve = await spawnUntilReady({
    label: 'orcad serve',
    program: orcadRuntime!,
    args: [
      path.join(slotDir, 'orcad.js'),
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--pairing-address',
      '127.0.0.1',
      '--json'
    ],
    env: { ...profile.env, ORCA_USER_DATA: profile.userDataDir },
    timeoutMs: 120_000,
    parseReady: (stdout) => {
      const newline = stdout.indexOf('\n')
      return newline === -1 ? null : JSON.parse(stdout.slice(0, newline))
    }
  })
  const page = await startPageServer()
  const client = new RuntimeClient(profile.userDataDir, 15_000)
  let desktop: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    const pairingUrl = serve.ready.pairing?.url
    expect(pairingUrl, serve.stderr()).toEqual(expect.any(String))
    const status = await client.call<{ capabilities: string[] }>('status.get')
    expect(status.result.capabilities).toContain('browser.clientHost.v1')
    await client.call('repo.add', { path: testRepoPath, kind: 'git' })

    const worktree = `path:${testRepoPath}`
    const openUrl = (): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      runProcess({
        program: process.execPath,
        args: [
          path.join(process.cwd(), 'out', 'cli', 'index.js'),
          'open-url',
          '--url',
          page.url,
          '--worktree',
          worktree,
          '--json'
        ],
        env: { ...profile.env, ORCA_USER_DATA: profile.userDataDir },
        timeoutMs: 90_000
      })

    // No desktop has taken this server's pages yet: a typed refusal that says what to do.
    const refused = await openUrl()
    writeFileSync(
      testInfo.outputPath('open-url-before-desktop.txt'),
      refused.stdout + refused.stderr
    )
    expect(refused.code).not.toBe(0)
    expect(refused.stdout + refused.stderr).toContain('browser_host_unavailable')

    desktop = await launchPairedElectronClient({ pairingUrl }, testInfo, '#30731 desktop')
    const worktreeId = await expect
      .poll(
        () =>
          desktop!.page.evaluate(
            (repoPath) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((entry) => entry.path === repoPath)?.id ?? null,
            testRepoPath
          ),
        { timeout: 60_000 }
      )
      .not.toBeNull()
      .then(() =>
        desktop!.page.evaluate(
          (repoPath) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((entry) => entry.path === repoPath)?.id ?? '',
          testRepoPath
        )
      )
    // The user opens a browser tab in the server's workspace, as in the report.
    await desktop.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: desktop.environmentId, worktreeId }
    )
    await expect
      .poll(
        () =>
          desktop!.page.evaluate(
            (id) => window.__store?.getState().activeGroupIdByWorktree[id] ?? null,
            worktreeId
          ),
        { timeout: 60_000, message: 'the server workspace never got a tab group on the desktop' }
      )
      .not.toBeNull()
    await desktop.page.evaluate(async () => {
      const state = window.__store?.getState()
      const groupId = state?.activeWorktreeId
        ? state.activeGroupIdByWorktree[state.activeWorktreeId]
        : undefined
      if (!state || !groupId) {
        throw new Error('desktop has no active tab group in the server workspace')
      }
      state.setBrowserDefaultUrl('about:blank')
      await state.openNewBrowserTabInActiveWorkspace(groupId)
    })

    let opened: { code: number | null; stdout: string; stderr: string } | null = null
    await expect
      .poll(
        async () => {
          opened = await openUrl()
          return opened.code
        },
        { timeout: 60_000, intervals: [2_000] }
      )
      .toBe(0)
    writeFileSync(testInfo.outputPath('open-url-with-desktop.txt'), opened!.stdout + opened!.stderr)
    const browserPageId = JSON.parse(opened!.stdout).result.browserPageId
    expect(browserPageId).toEqual(expect.any(String))

    await expect
      .poll(() => readDesktopPageMarker(desktop!.app, page.url), {
        timeout: 60_000,
        message: "the desktop never rendered the server's loopback page"
      })
      .toBe(MARKER)
    // Client placement: the server owns the page and the desktop renders it.
    const mirrored = await desktop.page.evaluate(
      ({ remotePageId, worktreeId }) => {
        const state = window.__store?.getState()
        for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
          for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
            const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
            if ((handle?.remotePageId ?? browserPage.id) === remotePageId) {
              return { localPageId: browserPage.id, placement: handle?.placement?.kind ?? null }
            }
          }
        }
        return null
      },
      { remotePageId: browserPageId, worktreeId }
    )
    expect(mirrored?.placement).toBe('client')
    // Only for the evidence screenshot: bring the page's pane forward inside the hidden window.
    await desktop.page.evaluate(
      ({ localPageId, worktreeId }) =>
        window.__store
          ?.getState()
          .focusBrowserTabInWorktree(worktreeId, localPageId, { surfacePane: true }),
      { localPageId: mirrored?.localPageId ?? '', worktreeId }
    )
    await desktop.page.screenshot({ path: testInfo.outputPath('desktop-with-open-url-page.png') })
    const tabs = await runProcess({
      program: process.execPath,
      args: [
        path.join(process.cwd(), 'out', 'cli', 'index.js'),
        'tab',
        'list',
        '--worktree',
        worktree,
        '--json'
      ],
      env: { ...profile.env, ORCA_USER_DATA: profile.userDataDir },
      timeoutMs: 30_000
    })
    writeFileSync(testInfo.outputPath('tab-list-with-desktop.txt'), tabs.stdout + tabs.stderr)
    expect(tabs.code, tabs.stderr).toBe(0)
    expect(JSON.parse(tabs.stdout).result.tabs).toContainEqual(
      expect.objectContaining({ browserPageId, url: page.url })
    )
  } finally {
    await desktop?.dispose()
    await new Promise((settle) => page.server.close(settle))
    await serve.stop()
    await cleanupE2EDaemons(profile.userDataDir)
  }
})
