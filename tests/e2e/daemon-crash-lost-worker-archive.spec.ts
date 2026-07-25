import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import type { ElectronApplication, Page } from '@stablyai/playwright-test'

import { DaemonClient } from '../../src/main/daemon/client'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../src/main/daemon/daemon-spawner'
import { PROTOCOL_VERSION, type ListSessionsResult } from '../../src/main/daemon/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { test, expect } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  getTerminalContent,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

type PaneIdentity = {
  cols: number
  leafId: string
  ptyId: string
  rows: number
}

type DaemonCreateTrace = {
  attachOnly: boolean
  hasHistorySeed: boolean
  pid: number
  sessionId: string
}

type LostWorkerSpawnReceipt = {
  lostWorkerRecovery?: {
    archiveId?: string
    code?: string
    kind: 'archived' | 'retryable-error'
  }
}

type PersistedArchive = {
  reason?: string
  sourceTabId?: string
}

type PersistedData = {
  terminalArchivesById?: Record<string, PersistedArchive>
  workspaceSession?: {
    terminalArchiveHintsByPaneKey?: Record<string, { launchAgent?: string }>
  }
}

/**
 * Record every `createOrAttach` request from the process that *sends* it.
 *
 * Why installed through `app.evaluate` instead of a `--require` preload:
 * Playwright deletes `NODE_OPTIONS` before it launches Electron
 * (`playwright-core/lib/server/electron/electron.js:169`, right before
 * `launchProcess`), so an env-injected probe never loads in any process —
 * neither the daemon nor main. Playwright's own main-process channel is the
 * only injection vector that survives that deletion.
 *
 * Why the Electron main process is the right place to watch: this test
 * force-kills the daemon, so a probe living inside it dies with the incarnation
 * whose recovery it exists to observe. Main survives every renderer reload and
 * the daemon respawn, and it is the sole sender of `createOrAttach` —
 * `DaemonClient.request()` writes the NDJSON request onto its outbound control
 * socket (`src/main/daemon/client.ts:238`), so the trace spans both daemon
 * incarnations.
 */
async function installCreateOrAttachTrace(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    type TraceEntry = {
      attachOnly: boolean
      hasHistorySeed: boolean
      pid: number
      sessionId: string
    }
    const scope = globalThis as typeof globalThis & {
      __orcaCreateOrAttachTrace?: TraceEntry[]
    }
    if (scope.__orcaCreateOrAttachTrace) {
      return
    }
    const trace: TraceEntry[] = []
    scope.__orcaCreateOrAttachTrace = trace

    // Why not a plain `require`: Playwright evaluates this function in a scope
    // with no module-level `require`, and a dynamic `import()` would be
    // rewritten by the test transform. `process.getBuiltinModule` is the
    // supported way to reach a builtin from such a scope and, unlike
    // `process.mainModule` (deprecated, and gone the moment main becomes ESM),
    // it does not bind this probe to the main entry staying CommonJS.
    type NetModule = {
      Socket: { prototype: { write: (this: unknown, ...args: unknown[]) => boolean } }
    }
    const runtime = process as typeof process & {
      getBuiltinModule?: (id: string) => unknown
      mainModule?: { require?: (id: string) => unknown }
    }
    const netModule =
      typeof runtime.getBuiltinModule === 'function'
        ? (runtime.getBuiltinModule('node:net') as NetModule)
        : typeof runtime.mainModule?.require === 'function'
          ? (runtime.mainModule.require('node:net') as NetModule)
          : null
    if (!netModule) {
      throw new Error(
        `createOrAttach trace cannot reach node:net (getBuiltinModule=${typeof runtime.getBuiltinModule}, mainModule=${typeof runtime.mainModule})`
      )
    }
    const socketPrototype = netModule.Socket.prototype
    const originalWrite = socketPrototype.write
    socketPrototype.write = function writeWithCreateOrAttachTrace(
      this: unknown,
      ...args: unknown[]
    ): boolean {
      const chunk = args[0]
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        // Why the substring test first: this hook sees every main-process socket
        // write (runtime WebSocket, hook endpoint, PTY keystrokes); parsing all
        // of them as JSON would burn time on writes that can never be a request.
        if (text.includes('"createOrAttach"')) {
          // Why splitting is enough: encodeNdjson/encodeBoundedNdjson emit
          // exactly one complete line per write() call, so no request message
          // can span two chunks.
          for (const line of text.split('\n')) {
            if (!line) {
              continue
            }
            try {
              const message = JSON.parse(line) as {
                type?: string
                payload?: { attachOnly?: boolean; historySeed?: string; sessionId?: string }
              }
              if (message.type === 'createOrAttach') {
                trace.push({
                  attachOnly: message.payload?.attachOnly === true,
                  hasHistorySeed:
                    typeof message.payload?.historySeed === 'string' &&
                    message.payload.historySeed.length > 0,
                  pid: process.pid,
                  sessionId: message.payload?.sessionId ?? ''
                })
              }
            } catch {
              // Observability must never alter a daemon request when a chunk is not NDJSON.
            }
          }
        }
      }

      return originalWrite.apply(this, args)
    }
  })
}

async function readCreateOrAttachTrace(app: ElectronApplication): Promise<DaemonCreateTrace[]> {
  return await app.evaluate(() => {
    type TraceEntry = {
      attachOnly: boolean
      hasHistorySeed: boolean
      pid: number
      sessionId: string
    }
    const scope = globalThis as typeof globalThis & {
      __orcaCreateOrAttachTrace?: TraceEntry[]
    }
    return scope.__orcaCreateOrAttachTrace ? [...scope.__orcaCreateOrAttachTrace] : []
  })
}

/** Restart the count without detaching the hook, which closes over the array. */
async function resetCreateOrAttachTrace(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __orcaCreateOrAttachTrace?: unknown[]
    }
    scope.__orcaCreateOrAttachTrace?.splice(0)
  })
}

function countCreateOrAttach(
  trace: DaemonCreateTrace[],
  match: (entry: DaemonCreateTrace) => boolean
): number {
  return trace.filter(match).length
}

function readDaemonPid(userDataDir: string): number | null {
  const pidPath = getDaemonPidPath(path.join(userDataDir, 'daemon'))
  if (!existsSync(pidPath)) {
    return null
  }

  try {
    const raw = readFileSync(pidPath, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown }
    const pid = parsed.pid
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function forceKillDaemon(pid: number): void {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }

  process.kill(pid, 'SIGKILL')
}

function readPersistedData(userDataDir: string): PersistedData | null {
  const statePath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  if (!existsSync(statePath)) {
    return null
  }

  return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedData
}

function workerArchives(data: PersistedData | null, tabId: string): [string, PersistedArchive][] {
  return Object.entries(data?.terminalArchivesById ?? {}).filter(
    ([, archive]) => archive.reason === 'daemon-worker-lost' && archive.sourceTabId === tabId
  )
}

function historyContains(userDataDir: string, marker: string): boolean {
  const historyRoot = path.join(userDataDir, 'terminal-history')
  if (!existsSync(historyRoot)) {
    return false
  }

  const pending = [historyRoot]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) {
      continue
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
      } else if (entry.isFile() && readFileSync(entryPath).includes(marker)) {
        return true
      }
    }
  }

  return false
}

async function readPaneIdentity(page: Page, tabId: string): Promise<PaneIdentity | null> {
  return page.evaluate((requestedTabId) => {
    const pane =
      window.__paneManagers?.get(requestedTabId)?.getActivePane?.() ??
      window.__paneManagers?.get(requestedTabId)?.getPanes?.()[0] ??
      null
    const leafId = pane?.container.dataset.leafId
    const ptyId = pane?.container.dataset.ptyId
    if (!ptyId || !leafId) {
      return null
    }

    return {
      cols: pane.terminal.cols,
      leafId,
      ptyId,
      rows: pane.terminal.rows
    }
  }, tabId)
}

async function getPaneIdentity(page: Page, tabId: string): Promise<PaneIdentity> {
  let identity: PaneIdentity | null = null
  await expect
    .poll(
      async () => {
        identity = await readPaneIdentity(page, tabId)
        return identity
      },
      {
        timeout: 15_000,
        message: `Pane for tab ${tabId} did not receive a PTY binding`
      }
    )
    .not.toBeNull()
  if (!identity) {
    throw new Error(`Pane for tab ${tabId} lost its PTY binding after the readiness check`)
  }
  return identity
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((requestedTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }

    store.getState().setActiveTab(requestedTabId)
    store.getState().setActiveTabType('terminal')
  }, tabId)
  await expect
    .poll(() =>
      page.locator('[data-testid="sortable-tab"][data-active="true"]').getAttribute('data-tab-id')
    )
    .toBe(tabId)
}

async function waitForTerminalOnTab(page: Page, tabId: string): Promise<void> {
  await activateTerminalTab(page, tabId)
  await waitForActiveTerminalManager(page, 30_000)
}

async function waitForArchivedWorkerPaneRetirement(page: Page, tabId: string): Promise<void> {
  await expect(page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)).toHaveCount(
    0,
    { timeout: 30_000 }
  )
  // Why: closeTab removes the tab before TerminalPane's unmount cleanup deletes its E2E manager.
  await expect
    .poll(
      () =>
        page.evaluate(
          (requestedTabId) => window.__paneManagers?.has(requestedTabId) ?? false,
          tabId
        ),
      {
        timeout: 5_000,
        message: `Archived worker tab ${tabId} retained a PaneManager after unmount`
      }
    )
    .toBe(false)
}

async function createTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabsBefore = await page.locator('[data-testid="sortable-tab"]').count()
  const tabId = await page.evaluate((requestedWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }

    return store.getState().createTab(requestedWorktreeId).id
  }, worktreeId)

  await expect
    .poll(() => page.locator('[data-testid="sortable-tab"]').count(), {
      timeout: 5_000,
      message: 'New terminal tab did not render'
    })
    .toBe(tabsBefore + 1)
  await expect(
    page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  ).toHaveAttribute('data-active', 'true')
  return tabId
}

async function reloadAndWaitForStore(page: Page, worktreeId: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__store))
  await expect
    .poll(() => page.evaluate(() => window.__store.getState().activeWorktreeId))
    .toBe(worktreeId)
}

async function listDaemonSessions(userDataDir: string): Promise<ListSessionsResult['sessions']> {
  const daemonRoot = path.join(userDataDir, 'daemon')
  const client = new DaemonClient({
    protocolVersion: PROTOCOL_VERSION,
    socketPath: getDaemonSocketPath(daemonRoot),
    tokenPath: getDaemonTokenPath(daemonRoot)
  })

  try {
    await client.ensureConnected()
    return (await client.request<ListSessionsResult>('listSessions', undefined)).sessions
  } finally {
    client.disconnect()
  }
}

test.describe('daemon crash lost worker archive', () => {
  test.setTimeout(180_000)

  test('archives a recognized worker without a replacement while cold-restoring one ordinary shell', async (// oxlint-disable-next-line no-empty-pattern -- The restart fixture owns Electron lifecycle instead of the shared fixtures.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const restartSession = createRestartSession(testInfo)

    let firstApp: ElectronApplication | null = null
    let restartedApp: ElectronApplication | null = null

    try {
      const firstLaunch = await restartSession.launch()
      const tracedApp = firstLaunch.app
      firstApp = tracedApp
      await installCreateOrAttachTrace(tracedApp)
      const page = firstLaunch.page
      const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
      await expect
        .poll(() => page.evaluate(() => window.__store?.getState().hydrationSucceeded === true), {
          timeout: 30_000,
          message: 'Workspace hydration did not complete before recording the worker hint'
        })
        .toBe(true)

      const workerTabId = await createTerminalTab(page, worktreeId)
      await waitForTerminalOnTab(page, workerTabId)
      const workerPane = await getPaneIdentity(page, workerTabId)
      const workerMarker = `WORKER-ARCHIVE-${testInfo.retry}-${Date.now()}`
      await page.evaluate(
        ({ marker, ptyId }) => window.api.pty.write(ptyId, `printf '${marker}\\n'\\n`),
        { marker: workerMarker, ptyId: workerPane.ptyId }
      )
      await waitForTerminalOutput(page, workerMarker)

      const hookEndpoint = await readHookEndpoint(firstApp)
      const workerHookDescriptor = await waitForActivePaneHookDescriptor(page)
      await emitCodexHookStatus(hookEndpoint, {
        paneKey: workerHookDescriptor.paneKey,
        prompt: 'daemon crash archive e2e worker marker',
        state: 'working',
        worktreeId
      })
      let workerHintBeforeCrash: string | undefined
      await expect
        .poll(() => {
          const hint = readPersistedData(restartSession.userDataDir)?.workspaceSession
            ?.terminalArchiveHintsByPaneKey?.[workerHookDescriptor.paneKey]
          workerHintBeforeCrash = hint?.launchAgent
          return workerHintBeforeCrash
        })
        .toBe('codex')

      await reloadAndWaitForStore(page, worktreeId)
      await waitForTerminalOnTab(page, workerTabId)
      await waitForTerminalOutput(page, workerMarker)
      expect(
        readPersistedData(restartSession.userDataDir)?.workspaceSession
          ?.terminalArchiveHintsByPaneKey?.[workerHookDescriptor.paneKey]?.launchAgent
      ).toBe('codex')

      const ordinaryTabId = await createTerminalTab(page, worktreeId)
      await waitForTerminalOnTab(page, ordinaryTabId)
      const ordinaryPane = await getPaneIdentity(page, ordinaryTabId)
      const ordinaryMarker = `ORDINARY-COLD-RESTORE-${testInfo.retry}-${Date.now()}`
      await page.evaluate(
        ({ marker, ptyId }) => window.api.pty.write(ptyId, `printf '${marker}\\n'\\n`),
        { marker: ordinaryMarker, ptyId: ordinaryPane.ptyId }
      )
      await waitForTerminalOutput(page, ordinaryMarker)

      await expect
        .poll(() => workerArchives(readPersistedData(restartSession.userDataDir), workerTabId))
        .toHaveLength(0)
      await expect
        .poll(() => historyContains(restartSession.userDataDir, workerMarker), { timeout: 20_000 })
        .toBe(true)
      await expect
        .poll(() => historyContains(restartSession.userDataDir, ordinaryMarker), {
          timeout: 20_000
        })
        .toBe(true)

      // Start the count at the crash boundary; the ordinary restore proves this probe saw real daemon RPC.
      await resetCreateOrAttachTrace(tracedApp)
      await expect.poll(() => readDaemonPid(restartSession.userDataDir)).not.toBeNull()
      const daemonPid = readDaemonPid(restartSession.userDataDir)
      if (daemonPid === null) {
        throw new Error('Daemon PID disappeared before the crash injection')
      }
      forceKillDaemon(daemonPid)

      // [PROBE] 分叉实验：hint 是被 daemon crash 弄丢的，还是被 reload 后渲染进程回写抹掉的
      const readHintNow = (): string | null =>
        readPersistedData(restartSession.userDataDir)?.workspaceSession
          ?.terminalArchiveHintsByPaneKey?.[workerHookDescriptor.paneKey]?.launchAgent ?? null
      const hintImmediatelyAfterCrash = readHintNow()
      await page.waitForTimeout(1500)
      const hintBeforeReload = readHintNow()

      await reloadAndWaitForStore(page, worktreeId)
      const hintAfterReload = readHintNow()
      console.log(
        `[PROBE] afterCrash=${JSON.stringify(hintImmediatelyAfterCrash)} beforeReload=${JSON.stringify(hintBeforeReload)} afterReload=${JSON.stringify(hintAfterReload)}`
      )
      await waitForTerminalOnTab(page, ordinaryTabId)
      await waitForTerminalOutput(page, ordinaryMarker)
      await expect(
        page.locator(`[data-testid="sortable-tab"][data-tab-id="${ordinaryTabId}"]`)
      ).toHaveCount(1)
      await expect.poll(() => readDaemonPid(restartSession.userDataDir)).not.toBe(daemonPid)
      const postCrashDurableState = () => {
        const persisted = readPersistedData(restartSession.userDataDir)
        return JSON.stringify({
          ordinaryHistoryPresent: historyContains(restartSession.userDataDir, ordinaryMarker),
          workerArchiveIds: workerArchives(persisted, workerTabId).map(([archiveId]) => archiveId),
          workerHintBeforeCrash,
          workerHint:
            persisted?.workspaceSession?.terminalArchiveHintsByPaneKey?.[
              workerHookDescriptor.paneKey
            ]?.launchAgent ?? null
        })
      }
      await expect
        .poll(postCrashDurableState, {
          timeout: 30_000,
          message: 'Durable-state probe missed the ordinary shell history positive control'
        })
        .toContain('"ordinaryHistoryPresent":true')
      await expect
        .poll(postCrashDurableState, {
          timeout: 30_000,
          message: 'Recognized worker did not produce a durable daemon-worker-lost archive'
        })
        .toMatch(/"workerArchiveIds":\[".+"\]/)
      await expect
        .poll(() => workerArchives(readPersistedData(restartSession.userDataDir), workerTabId))
        .toHaveLength(1)
      const archiveIdAfterCrash = workerArchives(
        readPersistedData(restartSession.userDataDir),
        workerTabId
      )[0]?.[0]
      expect(archiveIdAfterCrash).toBeTruthy()
      await waitForArchivedWorkerPaneRetirement(page, workerTabId)
      await expect
        .poll(
          () =>
            readPersistedData(restartSession.userDataDir)?.workspaceSession
              ?.terminalArchiveHintsByPaneKey?.[workerHookDescriptor.paneKey]
        )
        .toBeUndefined()

      // Why poll the two positive counts before asserting the zero: a negative
      // assertion over an unwired probe is vacuously true. Requiring the same
      // run to show the ordinary shell's cold restore and the worker's
      // attach-only probe proves this trace records real RPC, so the zero below
      // means "no replacement was requested" rather than "nothing was watching".
      await expect
        .poll(
          async () => {
            const trace = await readCreateOrAttachTrace(tracedApp)
            return {
              ordinaryColdRestores: countCreateOrAttach(
                trace,
                (entry) =>
                  entry.sessionId === ordinaryPane.ptyId &&
                  !entry.attachOnly &&
                  entry.hasHistorySeed
              ),
              workerAttachOnlyRequests: countCreateOrAttach(
                trace,
                (entry) => entry.sessionId === workerPane.ptyId && entry.attachOnly
              )
            }
          },
          {
            timeout: 20_000,
            message:
              'Main-side createOrAttach trace never observed the post-crash recovery RPC (ordinary cold restore + worker attach-only)'
          }
        )
        .toEqual({ ordinaryColdRestores: 1, workerAttachOnlyRequests: 1 })
      expect(
        countCreateOrAttach(
          await readCreateOrAttachTrace(tracedApp),
          (entry) => entry.sessionId === workerPane.ptyId && !entry.attachOnly
        )
      ).toBe(0)

      const sessionsAfterArchive = await listDaemonSessions(restartSession.userDataDir)
      expect(
        sessionsAfterArchive.filter((session) => session.sessionId === workerPane.ptyId)
      ).toHaveLength(0)
      const ordinarySessions = sessionsAfterArchive.filter(
        (session) => session.sessionId === ordinaryPane.ptyId
      )
      expect(ordinarySessions).toHaveLength(1)
      expect(ordinarySessions[0]?.pid).toBeGreaterThan(0)

      await reloadAndWaitForStore(page, worktreeId)
      await waitForTerminalOnTab(page, ordinaryTabId)
      await waitForTerminalOutput(page, ordinaryMarker)
      await expect(
        page.locator(`[data-testid="sortable-tab"][data-tab-id="${workerTabId}"]`)
      ).toHaveCount(0)
      await expect(page.locator('[data-testid="sortable-tab"][data-active="true"]')).toHaveCount(1)
      expect(await getTerminalContent(page)).toContain(ordinaryMarker)

      const archivesBeforeRestart = workerArchives(
        readPersistedData(restartSession.userDataDir),
        workerTabId
      )
      expect(archivesBeforeRestart).toHaveLength(1)
      expect(archivesBeforeRestart[0]?.[0]).toBe(archiveIdAfterCrash)

      await restartSession.close(firstApp)
      firstApp = null
      const restartLaunch = await restartSession.launch()
      restartedApp = restartLaunch.app
      const restartedPage = restartLaunch.page
      await expect
        .poll(() => restartedPage.evaluate(() => window.__store.getState().activeWorktreeId))
        .toBe(worktreeId)
      await waitForTerminalOnTab(restartedPage, ordinaryTabId)
      await waitForTerminalOutput(restartedPage, ordinaryMarker)

      await expect(
        restartedPage.locator(`[data-testid="sortable-tab"][data-tab-id="${workerTabId}"]`)
      ).toHaveCount(0)
      expect(workerArchives(readPersistedData(restartSession.userDataDir), workerTabId)).toEqual(
        archivesBeforeRestart
      )
      expect(await getTerminalContent(restartedPage)).toContain(ordinaryMarker)
    } finally {
      if (restartedApp) {
        await restartSession.close(restartedApp)
      }
      if (firstApp) {
        await restartSession.close(firstApp)
      }
      await restartSession.dispose()
    }
  })

  // Why a separate test instead of another beat in the timeline above: the race
  // needs the recovery window that exists only *before* the archive lands — the
  // hint is still on disk and the in-flight dedupe entry has not been deleted
  // yet. After the first test's reload-driven archive both preconditions are
  // gone, and moving the concurrent spawn earlier would replace that reload with
  // a hand-rolled spawn and lose the reload path's coverage.
  test('collapses concurrent lost-worker spawns into one archive without a replacement', async (// oxlint-disable-next-line no-empty-pattern -- The restart fixture owns Electron lifecycle instead of the shared fixtures.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const restartSession = createRestartSession(testInfo)

    let app: ElectronApplication | null = null

    try {
      const launched = await restartSession.launch()
      const tracedApp = launched.app
      app = tracedApp
      await installCreateOrAttachTrace(tracedApp)
      const page = launched.page
      const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
      await expect
        .poll(() => page.evaluate(() => window.__store?.getState().hydrationSucceeded === true), {
          timeout: 30_000,
          message: 'Workspace hydration did not complete before recording the worker hint'
        })
        .toBe(true)

      const workerTabId = await createTerminalTab(page, worktreeId)
      await waitForTerminalOnTab(page, workerTabId)
      const workerPane = await getPaneIdentity(page, workerTabId)
      const workerMarker = `RACE-WORKER-${testInfo.retry}-${Date.now()}`
      await page.evaluate(
        ({ marker, ptyId }) => window.api.pty.write(ptyId, `printf '${marker}\\n'\\n`),
        { marker: workerMarker, ptyId: workerPane.ptyId }
      )
      await waitForTerminalOutput(page, workerMarker)

      const hookEndpoint = await readHookEndpoint(tracedApp)
      const workerHookDescriptor = await waitForActivePaneHookDescriptor(page)
      await emitCodexHookStatus(hookEndpoint, {
        paneKey: workerHookDescriptor.paneKey,
        prompt: 'daemon crash archive e2e race marker',
        state: 'working',
        worktreeId
      })
      await expect
        .poll(
          () =>
            readPersistedData(restartSession.userDataDir)?.workspaceSession
              ?.terminalArchiveHintsByPaneKey?.[workerHookDescriptor.paneKey]?.launchAgent
        )
        .toBe('codex')

      // Why an ordinary shell here too: the brief requires the zero-replacement
      // assertion to carry a same-run positive control from an ordinary shell
      // (B3c-e2e-daemon-crash-brief.md:53). The worker's own attach-only count
      // cannot serve as that control — a spawn that reaches the dying daemon is
      // retried after the respawn, so it is not an exact quantity.
      const ordinaryTabId = await createTerminalTab(page, worktreeId)
      await waitForTerminalOnTab(page, ordinaryTabId)
      const ordinaryPane = await getPaneIdentity(page, ordinaryTabId)
      const ordinaryMarker = `RACE-ORDINARY-${testInfo.retry}-${Date.now()}`
      await page.evaluate(
        ({ marker, ptyId }) => window.api.pty.write(ptyId, `printf '${marker}\\n'\\n`),
        { marker: ordinaryMarker, ptyId: ordinaryPane.ptyId }
      )
      await waitForTerminalOutput(page, ordinaryMarker)

      // Why wait for durable history: the recovery path can only archive what it
      // can capture, and the cold-restore payload is rebuilt from the on-disk
      // terminal history. Killing the daemon before the flush lands turns this
      // scenario into a `capture-unavailable` receipt that proves nothing.
      for (const marker of [workerMarker, ordinaryMarker]) {
        await expect
          .poll(() => historyContains(restartSession.userDataDir, marker), { timeout: 20_000 })
          .toBe(true)
      }

      // Start the count at the crash boundary so pre-crash mounts can't be
      // mistaken for a recovery-time replacement request.
      await resetCreateOrAttachTrace(tracedApp)
      await expect.poll(() => readDaemonPid(restartSession.userDataDir)).not.toBeNull()
      const daemonPid = readDaemonPid(restartSession.userDataDir)
      if (daemonPid === null) {
        throw new Error('Daemon PID disappeared before the crash injection')
      }
      forceKillDaemon(daemonPid)

      // Why no reload before this: the renderer must stay mounted so both spawn
      // calls land inside the same recovery window. The dead daemon is respawned
      // lazily by the first call that hits it (daemon-pty-adapter.ts:1442), which
      // is exactly the contention this scenario is about.
      //
      // What this does and does not lock, stated plainly: both calls name the
      // same pane, so they merge at the pane-level reservation
      // (`paneSpawnReservationsByPaneKey`, pty.ts:5068) — one layer above the
      // archive-level `lostWorkerArchiveInFlight` map (pty.ts:2014). So this
      // proves "concurrent callers yield exactly one archive and no
      // replacement", NOT that the archive map itself dedupes.
      //
      // Two panes of one tab would give two admissions sharing a tab-level
      // `operationKey`, but that construction cannot finish an archive on *this*
      // path: under normal local persistence the non-calling leaf has no
      // snapshot source — local layouts have `buffersByLeafId` and
      // `scrollbackRefsByLeafId` pruned on persist
      // (workspace-session-terminal-buffers.ts:79-125), only the calling leaf
      // may use cold-restore data (pty.ts:2044-2055), and a single `unavailable`
      // leaf fails the whole capture (terminal-archive-store.ts:124-128). That
      // is a product gap tracked separately, and it is a statement about this
      // daemon pre-spawn path, not proof that the map is unreachable in general:
      // the renderer candidate handler (pty.ts:1838-1980) can supply
      // `snapshotsByLeafId` and reach the same map. Locking that belongs in a
      // main-IPC integration test, not here — left uncovered deliberately rather
      // than papered over.
      const raceReceipts = (await page.evaluate(
        async ({ cwd, pane, tabId, requestedWorktreeId }) =>
          Promise.all(
            [0, 1].map(() =>
              window.api.pty.spawn({
                cols: pane.cols,
                cwd,
                leafId: pane.leafId,
                rows: pane.rows,
                sessionId: pane.ptyId,
                tabId,
                worktreeId: requestedWorktreeId
              })
            )
          ),
        { cwd: repoPath, pane: workerPane, requestedWorktreeId: worktreeId, tabId: workerTabId }
      )) as LostWorkerSpawnReceipt[]

      // Why the ordinary shell restores after the worker race rather than inside
      // it: it is the same-run positive control for the probe, not part of the
      // contention under test, and keeping it out of that batch leaves the two
      // worker admissions competing only with each other.
      await page.evaluate(
        ({ cwd, ordinary, ordinaryTab, requestedWorktreeId }) =>
          window.api.pty.spawn({
            cols: ordinary.cols,
            cwd,
            leafId: ordinary.leafId,
            rows: ordinary.rows,
            sessionId: ordinary.ptyId,
            tabId: ordinaryTab,
            worktreeId: requestedWorktreeId
          }),
        {
          cwd: repoPath,
          ordinary: ordinaryPane,
          ordinaryTab: ordinaryTabId,
          requestedWorktreeId: worktreeId
        }
      )

      // Why project the receipts instead of asserting `.kind` twice: a failure
      // then reports the recovery `code` that explains it instead of a bare
      // "retryable-error".
      const raceOutcomes = raceReceipts.map((receipt) => ({
        archiveId: receipt.lostWorkerRecovery?.archiveId ?? null,
        code: receipt.lostWorkerRecovery?.code ?? null,
        kind: receipt.lostWorkerRecovery?.kind ?? 'missing'
      }))
      expect(raceOutcomes).toEqual([
        { archiveId: expect.any(String), code: null, kind: 'archived' },
        { archiveId: expect.any(String), code: null, kind: 'archived' }
      ])
      expect(raceOutcomes[1]?.archiveId).toBe(raceOutcomes[0]?.archiveId)

      await expect
        .poll(() => workerArchives(readPersistedData(restartSession.userDataDir), workerTabId), {
          timeout: 20_000,
          message: 'Concurrent lost-worker spawns did not settle on exactly one durable archive'
        })
        .toHaveLength(1)
      // Why bind the receipts to the durable row: two receipts agreeing on an ID
      // does not prove that ID is the archive that landed. Without this, both
      // callers could share one wrong ID while the real archive persisted under
      // another and the count-of-one above would still pass. (Cross-restart
      // stability of an archive ID is covered by the first test.)
      const durableRaceArchives = workerArchives(
        readPersistedData(restartSession.userDataDir),
        workerTabId
      )
      expect(durableRaceArchives[0]?.[0]).toBe(raceOutcomes[0]?.archiveId)

      // Same-run positive controls before the zero: the ordinary shell must show
      // exactly one cold restore, and the recovery path at least one attach-only
      // request. Without them a zero over an unwired probe is vacuously true.
      // Why the worker count is not exact: a spawn that reaches the daemon while
      // it is dying is retried once after the respawn
      // (daemon-pty-adapter.ts:1442), so one or two are both correct.
      await expect
        .poll(
          async () =>
            countCreateOrAttach(
              await readCreateOrAttachTrace(tracedApp),
              (entry) =>
                entry.sessionId === ordinaryPane.ptyId && !entry.attachOnly && entry.hasHistorySeed
            ),
          {
            timeout: 20_000,
            message: 'Main-side probe never observed the ordinary shell cold restore'
          }
        )
        .toBe(1)
      await expect
        .poll(
          async () =>
            countCreateOrAttach(
              await readCreateOrAttachTrace(tracedApp),
              (entry) => entry.sessionId === workerPane.ptyId && entry.attachOnly
            ),
          {
            timeout: 20_000,
            message: 'Main-side probe never observed the attach-only recovery request'
          }
        )
        .toBeGreaterThan(0)
      expect(
        countCreateOrAttach(
          await readCreateOrAttachTrace(tracedApp),
          (entry) => entry.sessionId === workerPane.ptyId && !entry.attachOnly
        )
      ).toBe(0)
    } finally {
      if (app) {
        await restartSession.close(app)
      }
      await restartSession.dispose()
    }
  })
})
