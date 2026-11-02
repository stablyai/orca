// With ORCA_LAYOUT_OWNER=main, show the server’s newer-build held-pane banner on its paired desktop; Reopen must stop the server service and rebind its pane.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../src/main/daemon/daemon-spawner'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { LAYOUT_REOPEN_HELD_PANES_CAPABILITY } from '../../src/shared/workspace-layout/layout-intents-capability'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  writeRetentionFixture
} from './helpers/host-created-terminal-retention-oracle'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  expectPanesBoundToHandles,
  openTab,
  readHostHandles,
  waitForWorktree
} from './helpers/paired-desktop-server-terminal-tab'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)
const NEWER_PROTOCOL = PROTOCOL_VERSION + 1
const BANNER_TITLE = 'This terminal was opened in a newer version of Orca'

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)
const sinkPath = path.join(scratch, 'server-held-pane.log')
// Named so its command line reads as a terminal service, which the server checks before stopping it.
const fakeDaemonPath = path.join(scratch, 'daemon-entry.mjs')
writeFileSync(
  fakeDaemonPath,
  [
    "import { createServer } from 'node:net'",
    "import { rmSync } from 'node:fs'",
    'const socketPath = process.argv[2]',
    'rmSync(socketPath, { force: true })',
    'createServer(() => {}).listen(socketPath)'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The server's own terminal service, or null once it has exited with the serve process. */
function readDaemonPid(userDataDir: string): number | null {
  const pidPath = getDaemonPidPath(path.join(userDataDir, 'daemon'))
  if (!existsSync(pidPath)) {
    return null
  }
  const parsed: unknown = JSON.parse(readFileSync(pidPath, 'utf8'))
  const pid = parsed && typeof parsed === 'object' && 'pid' in parsed ? parsed.pid : undefined
  return typeof pid === 'number' ? pid : null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number): Promise<void> {
  await expect.poll(() => isAlive(pid), { timeout: 15_000 }).toBe(false)
}

/** A newer build's terminal service as this build sees one: a live process its PID record names. */
function startFakeNewerDaemon(userDataDir: string): ChildProcess {
  const runtimeDir = path.join(userDataDir, 'daemon')
  const socketPath = getDaemonSocketPath(runtimeDir, NEWER_PROTOCOL)
  const tokenPath = getDaemonTokenPath(runtimeDir, NEWER_PROTOCOL)
  writeFileSync(tokenPath, 'newer-token', { mode: 0o600 })
  const child = spawn(process.execPath, [fakeDaemonPath, socketPath, tokenPath], {
    stdio: 'ignore'
  })
  writeFileSync(
    getDaemonPidPath(runtimeDir, NEWER_PROTOCOL),
    JSON.stringify({ pid: child.pid, startedAtMs: Date.now() }),
    { mode: 0o600 }
  )
  return child
}

/** The banner's text in the desktop pane showing `leafId`, or null when it shows none. */
async function paneBannerText(
  client: PairedElectronClient,
  webTabId: string,
  leafId: string
): Promise<string | null> {
  return client.page.evaluate(
    ({ webTabId, leafId, title }) => {
      const pane = window.__paneManagers
        ?.get(webTabId)
        ?.getPanes?.()
        .find((entry) => entry.container.dataset.leafId === leafId)
      const text = pane?.container.textContent ?? ''
      return text.includes(title) ? text : null
    },
    { webTabId, leafId, title: BANNER_TITLE }
  )
}

test.describe("paired desktop reopens a switch-on server's held pane", () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')
  test.skip(process.platform === 'win32', 'The fake terminal service is a Unix socket')

  test('the server pane shows the banner, Reopen goes to the server, and the pane binds', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(480_000)
    const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
    let client: PairedElectronClient | null = null
    const fake: { daemon: ChildProcess | null } = { daemon: null }
    try {
      const status = await host.client.call<{ capabilities?: string[] }>('status.get')
      expect(status.result.capabilities ?? []).toContain(LAYOUT_REOPEN_HELD_PANES_CAPABILITY)
      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      const worktreeId = await waitForWorktree(host, added.result.repo.id)
      const created = await createHostCliTerminal(
        async <TResult>(method: string, params: unknown) =>
          (await host.client.call<TResult>(method, params)).result,
        worktreeId,
        fixturePath,
        sinkPath
      )
      const hostTabId = created.tabId.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
      const webTabId = toWebTerminalSurfaceTabId(hostTabId)
      await expect
        .poll(() => (existsSync(sinkPath) ? readFileSync(sinkPath, 'utf8') : ''), {
          timeout: 30_000
        })
        .toContain('READY:')

      client = await launchPairedElectronClient(host.offer, testInfo, 'server-held-pane')
      const desktop = client
      await openTab(desktop, worktreeId, webTabId)
      await expectPanesBoundToHandles(host, desktop, worktreeId, hostTabId, [created.leafId])

      await test.step('a restart beside a newer build holds the pane, and the banner shows', async () => {
        await host.restartServeProcess({
          betweenProcesses: async () => {
            // Its terminal dies with the service, as on a reboot, so the pane restores cold.
            const daemonPid = readDaemonPid(host.userDataDir)
            if (daemonPid !== null && isAlive(daemonPid)) {
              process.kill(daemonPid, 'SIGKILL')
              await waitForExit(daemonPid)
            }
            fake.daemon = startFakeNewerDaemon(host.userDataDir)
          }
        })
        await expect
          .poll(() => paneBannerText(desktop, webTabId, created.leafId), {
            timeout: 120_000,
            message: "The desktop never showed the server's held pane on the banner"
          })
          .toContain('Reopen terminal')
        expect(await readHostHandles(host, worktreeId, hostTabId)).toEqual({
          [created.leafId]: null
        })
      })

      await test.step("Reopen stops the server's newer build and the pane binds", async () => {
        await desktop.page.getByRole('button', { name: 'Reopen terminal' }).click()
        const fakePid = fake.daemon?.pid
        expect(fakePid).toBeDefined()
        await waitForExit(fakePid!)
        await expect
          .poll(() => paneBannerText(desktop, webTabId, created.leafId), {
            timeout: 60_000,
            message: 'The banner stayed after the server reopened the pane'
          })
          .toBeNull()
        await expectPanesBoundToHandles(host, desktop, worktreeId, hostTabId, [created.leafId])
      })
    } finally {
      if (fake.daemon?.pid && isAlive(fake.daemon.pid)) {
        fake.daemon.kill('SIGKILL')
      }
      await client?.dispose()
      await host.dispose()
    }
  })
})
