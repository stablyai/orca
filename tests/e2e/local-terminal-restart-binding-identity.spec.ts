/**
 * Journey 1 (local half): the same pane, the same durable PTY binding, and the
 * same OS shell process must survive a renderer reload and a full app restart,
 * and a stale exact operation naming an older pane generation must be rejected
 * rather than applied.
 *
 * Oracle notes:
 *   - Process identity is the *OS* process, checked by PID **and** kernel start
 *     time (`ps -o lstart=`), so a recycled PID cannot pass as "survived".
 *   - The stale operation is a real `session:set` payload of the shape an
 *     older/lagging renderer publishes when its snapshot predates the spawn
 *     commit (issue #217): live layout, empty `ptyIdsByLeafId`. Main must keep
 *     the durable binding instead of letting the stale write erase it.
 *   - Asserting the *binding* alone would not discriminate: with the daemon
 *     torn down at quit, the pane and the PTY id both come back identical and
 *     only the OS process differs. A persisted row is not a live process.
 *
 * Discrimination protocol (each guard removal must turn the named test red):
 *   1. `src/main/index.ts` will-quit — force `shutdownDaemon()` instead of
 *      `isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()`
 *      → the reload/restart test fails on a changed shell PID.
 *   2. `src/main/persistence.ts` `setLocalWorkspaceSession` — delete the
 *      `restorableBindings` reconciliation → the stale-write test fails with an
 *      erased `ptyIdsByLeafId` entry, while test 1 stays green.
 *
 * Run with an isolated `TMPDIR`: the seeded-repo pointer lives at
 * `os.tmpdir()/orca-e2e-test-repo-path.txt`, so a concurrent e2e run on the
 * same machine deletes this run's repo mid-test.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  readPaneIdentitySnapshot,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

// Why: two Electron launches per test; serial keeps the profile lock and the
// daemon handoff interpretable when something fails.
test.describe.configure({ mode: 'serial' })

type PaneBinding = {
  tabId: string
  leafId: string
  ptyId: string
}

type OsProcessIdentity = {
  pid: number
  startedAt: string
}

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

/** Kernel-reported start time; distinguishes a survivor from a recycled PID. */
function readOsProcessIdentity(pid: number): OsProcessIdentity {
  // Why two probes: `ps` does not exist on Windows, and a PID alone cannot tell
  // a survivor from a reused number — both platforms must report a start time.
  const startedAt = (
    process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('o')`
          ],
          { encoding: 'utf8' }
        )
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  )
    .trim()
    .replace(/\s+/g, ' ')
  if (!startedAt) {
    throw new Error(`PID ${pid} is not alive`)
  }
  return { pid, startedAt }
}

async function readPaneBinding(page: Page): Promise<PaneBinding> {
  // Why poll: the binding is read off a DOM dataset attribute, and a reload
  // remounts the pane before it republishes. A single read here failed every
  // run on a slower host while the app was demonstrably healthy — the
  // assertion is unchanged, it is just awaited.
  await expect
    .poll(async () => (await readPaneIdentitySnapshot(page))?.panes[0]?.ptyId ?? null, {
      timeout: 30_000,
      message: 'No bound terminal pane is mounted'
    })
    .not.toBeNull()
  const snapshot = await readPaneIdentitySnapshot(page)
  const pane = snapshot?.panes[0]
  if (!snapshot || !pane?.ptyId) {
    throw new Error('No bound terminal pane is mounted')
  }
  return { tabId: snapshot.tabId, leafId: pane.leafId, ptyId: pane.ptyId }
}

/**
 * Ask the live shell for its own PID. `$$` is the shell process itself, so an
 * equal value across a restart means the daemon handed back the same process,
 * not a look-alike respawn.
 */
async function readShellProcessIdentity(
  page: Page,
  ptyId: string,
  phase: string
): Promise<OsProcessIdentity> {
  const marker = `ORCA_SHELL_PID_${phase}`
  // Why: the echoed command line also contains the marker, so match the
  // *expanded* value — only the shell's own output carries digits.
  const reported = new RegExp(`${marker}=(\\d+)`)
  // `$$` is POSIX; PowerShell exposes the same thing as `$PID`.
  await execInTerminal(
    page,
    ptyId,
    process.platform === 'win32' ? `echo ${marker}=$PID` : `echo ${marker}=$$`
  )
  let pid: number | null = null
  await expect
    .poll(
      async () => {
        const match = (await getTerminalContent(page, 20_000)).match(reported)
        pid = match ? Number(match[1]) : null
        return pid !== null
      },
      {
        timeout: 20_000,
        message: `Shell never reported its PID for phase ${phase}`
      }
    )
    .toBe(true)
  return readOsProcessIdentity(pid!)
}

async function readPersistedPaneBinding(
  page: Page,
  binding: PaneBinding
): Promise<string | undefined> {
  return page.evaluate(
    async ({ tabId, leafId }) =>
      (await window.api.session.get())?.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[leafId],
    { tabId: binding.tabId, leafId: binding.leafId }
  )
}

async function settleRestoredLaunch(page: Page, expectedWorktreeId: string): Promise<void> {
  await waitForSessionReady(page)
  await expect.poll(() => getActiveWorktreeId(page), { timeout: 30_000 }).toBe(expectedWorktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
}

type BootstrappedPane = {
  worktreeId: string
  binding: PaneBinding
  process: OsProcessIdentity
}

async function bootstrapBoundPane(page: Page, repoPath: string): Promise<BootstrappedPane> {
  const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)

  const ptyId = await discoverActivePtyId(page)
  const binding = await readPaneBinding(page)
  expect(binding.ptyId).toBe(ptyId)
  return {
    worktreeId,
    binding,
    process: await readShellProcessIdentity(page, ptyId, 'BOOT')
  }
}

async function reloadRenderer(page: Page, worktreeId: string): Promise<void> {
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__store), null, {
    timeout: 30_000
  })
  await settleRestoredLaunch(page, worktreeId)
}

function expectSamePane(actual: PaneBinding, expected: PaneBinding): void {
  expect(actual.ptyId).toBe(expected.ptyId)
  expect(actual.leafId).toBe(expected.leafId)
  expect(actual.tabId).toBe(expected.tabId)
}

test.describe('Local terminal pane/binding/process identity across restart', () => {
  test('the same pane, PTY binding, and OS shell process survive renderer reload and app restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()
    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await session.launch()
      firstApp = first.app
      const {
        worktreeId,
        binding,
        process: bootProcess
      } = await bootstrapBoundPane(first.page, repoPath)

      await reloadRenderer(first.page, worktreeId)
      expectSamePane(await readPaneBinding(first.page), binding)
      expect(await readShellProcessIdentity(first.page, binding.ptyId, 'RELOAD')).toEqual(
        bootProcess
      )

      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      await settleRestoredLaunch(second.page, worktreeId)
      expectSamePane(await readPaneBinding(second.page), binding)
      expect(await readPersistedPaneBinding(second.page, binding)).toBe(binding.ptyId)
      expect(await readShellProcessIdentity(second.page, binding.ptyId, 'RESTART')).toEqual(
        bootProcess
      )
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('a stale pre-spawn session write is rejected instead of retiring the live pane binding', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()
    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await session.launch()
      firstApp = first.app
      const {
        worktreeId,
        binding,
        process: bootProcess
      } = await bootstrapBoundPane(first.page, repoPath)

      // A lagging renderer republishes a snapshot taken before the spawn
      // committed: the pane is still live, but it carries no binding at all.
      const staleWriteDelivered = await first.page.evaluate(async (tabId: string) => {
        const current = await window.api.session.get()
        const layout = current?.terminalLayoutsByTabId?.[tabId]
        if (!layout || Object.keys(layout.ptyIdsByLeafId ?? {}).length === 0) {
          return false
        }
        await window.api.session.set({
          ...current,
          terminalLayoutsByTabId: {
            ...current.terminalLayoutsByTabId,
            [tabId]: { ...layout, ptyIdsByLeafId: {} }
          }
        })
        await window.api.session.flush()
        return true
      }, binding.tabId)
      expect(staleWriteDelivered).toBe(true)

      expect(await readPersistedPaneBinding(first.page, binding)).toBe(binding.ptyId)

      // The rejection has to hold through both restore boundaries, or the pane
      // comes back cold on a different OS process.
      await reloadRenderer(first.page, worktreeId)
      expectSamePane(await readPaneBinding(first.page), binding)
      expect(await readShellProcessIdentity(first.page, binding.ptyId, 'RELOAD')).toEqual(
        bootProcess
      )

      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      await settleRestoredLaunch(second.page, worktreeId)
      expectSamePane(await readPaneBinding(second.page), binding)
      expect(await readShellProcessIdentity(second.page, binding.ptyId, 'RESTART')).toEqual(
        bootProcess
      )
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })
})
