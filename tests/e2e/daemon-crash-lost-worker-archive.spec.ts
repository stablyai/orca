import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

function writeDaemonRpcProbe(root: string): {
  logPath: string
  probePath: string
} {
  mkdirSync(root, { recursive: true })
  const logPath = path.join(root, 'daemon-create-or-attach.ndjson')
  const probePath = path.join(root, 'daemon-rpc-probe.cjs')

  writeFileSync(
    probePath,
    `const { appendFileSync } = require('node:fs')
const net = require('node:net')

const logPath = process.env.ORCA_E2E_DAEMON_CREATE_LOG
if (logPath && process.argv.some((argument) => String(argument).includes('daemon-entry'))) {
  const bufferedBySocket = new WeakMap()
  const originalEmit = net.Socket.prototype.emit

  net.Socket.prototype.emit = function emitWithCreateOrAttachTrace(event, ...arguments) {
    if (event === 'data') {
      const previous = bufferedBySocket.get(this) || ''
      const next = previous + Buffer.from(arguments[0]).toString('utf8')
      const lines = next.split('\\n')
      bufferedBySocket.set(this, lines.pop() || '')

      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.type === 'createOrAttach') {
            appendFileSync(logPath, JSON.stringify({
              attachOnly: message.payload?.attachOnly === true,
              hasHistorySeed: typeof message.payload?.historySeed === 'string' && message.payload.historySeed.length > 0,
              pid: process.pid,
              sessionId: message.payload?.sessionId,
            }) + '\\n')
          }
        } catch {
          // Observability must never alter a daemon request when a chunk is not NDJSON.
        }
      }
    }

    return originalEmit.call(this, event, ...arguments)
  }
}

`
  )
  writeFileSync(logPath, '')
  return { logPath, probePath }
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

    const probeRoot = path.join(
      tmpdir(),
      `orca-daemon-crash-archive-${testInfo.testId.replaceAll(/[^a-zA-Z0-9]/g, '-')}`
    )
    const { logPath, probePath } = writeDaemonRpcProbe(probeRoot)
    const restartSession = createRestartSession(testInfo, {
      NODE_OPTIONS: `--require=${probePath}`,
      ORCA_E2E_DAEMON_CREATE_LOG: logPath
    })

    let firstApp: ElectronApplication | null = null
    let restartedApp: ElectronApplication | null = null

    try {
      const firstLaunch = await restartSession.launch()
      firstApp = firstLaunch.app
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
      writeFileSync(logPath, '')
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
      rmSync(probeRoot, { force: true, recursive: true })
    }
  })
})
