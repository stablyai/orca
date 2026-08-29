import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

const PARK_DELAY_MS = 2_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-host-restart-background-'))
const fixturePath = path.join(scratch, 'paired-host-restart-terminal.mjs')
const backlogPath = path.join(scratch, 'daemon-stream-backlog.jsonl')

writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    "process.stdout.write('READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    appendFileSync(sink, `${line}\\n`)',
    '    process.stdout.write(`LIVE:${line}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(sinkPath: string): string {
  const command = [process.execPath, fixturePath, sinkPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

function readDaemonPid(userDataDir: string): number {
  const value = JSON.parse(
    readFileSync(path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`), 'utf8')
  ) as { pid?: unknown }
  if (typeof value.pid !== 'number') {
    throw new Error('Daemon pid file did not contain a numeric pid')
  }
  return value.pid
}

type BacklogEntry = {
  atMs?: number
  background?: boolean
  backgroundedSessionIdSuffixes?: string[]
  event?: string
  sessionIdSuffix?: string
}

function readBacklogEntries(): BacklogEntry[] {
  try {
    return readFileSync(backlogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as BacklogEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

type HostTerminal = {
  handle: string
  parentTabId: string
  ptyId: string
  sinkPath: string
  webTabId: string
}

async function createHostTerminal(
  client: PairedElectronClient,
  worktreeId: string,
  name: string
): Promise<HostTerminal> {
  const sinkPath = path.join(scratch, `${name}.log`)
  const created = await callRuntime<{
    tab: { id: string; parentTabId: string; terminal: string | null }
  }>(client.page, client.environmentId, 'session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command: fixtureCommand(sinkPath),
    activate: false,
    select: false,
    navigation: 'caller'
  })
  if (!created.tab.terminal) {
    throw new Error('Host did not publish the fixture terminal')
  }
  const shown = await callRuntime<{ terminal: { ptyId: string | null } }>(
    client.page,
    client.environmentId,
    'terminal.show',
    { terminal: created.tab.terminal }
  )
  if (!shown.terminal.ptyId) {
    throw new Error('Host fixture terminal has no PTY')
  }
  const parentTabId =
    created.tab.parentTabId || created.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
  return {
    handle: created.tab.terminal,
    parentTabId,
    ptyId: shown.terminal.ptyId,
    sinkPath,
    webTabId: toWebTerminalSurfaceTabId(parentTabId)
  }
}

async function findTerminalHandle(
  client: PairedElectronClient,
  worktreeId: string,
  parentTabId: string
): Promise<string> {
  let terminal: string | null = null
  await expect
    .poll(
      async () => {
        const snapshot = await callRuntime<{
          tabs: { type: string; parentTabId?: string; terminal?: string | null }[]
        }>(client.page, client.environmentId, 'session.tabs.list', {
          worktree: `id:${worktreeId}`
        })
        terminal =
          snapshot.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === parentTabId)
            ?.terminal ?? null
        return terminal
      },
      { timeout: 30_000, message: `Host did not republish terminal tab ${parentTabId}` }
    )
    .not.toBeNull()
  if (!terminal) {
    throw new Error(`Host did not republish terminal tab ${parentTabId}`)
  }
  return terminal
}

async function openClientTab(page: Page, worktreeId: string, webTabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ worktreeId, webTabId }) =>
            (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
              (tab) => tab.id === webTabId
            ),
          { worktreeId, webTabId }
        ),
      { timeout: 60_000, message: `Client never mirrored host tab ${webTabId}` }
    )
    .toBe(true)
  await page.evaluate(
    ({ worktreeId, webTabId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(webTabId)
      state?.setActiveTabType('terminal')
    },
    { worktreeId, webTabId }
  )
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
      timeout: 60_000,
      message: `Client pane for ${webTabId} did not mount`
    })
    .toBe(true)
}

async function readPaneContent(page: Page, webTabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, webTabId)
}

async function waitForPaneConnected(page: Page, webTabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const manager = window.__paneManagers?.get(id)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container.dataset.ptyRecoveryState ?? null
        }, webTabId),
      { timeout: 30_000, message: `Pane ${webTabId} never completed transport recovery` }
    )
    .toBe('connected')
}

async function expectTerminalInteractive(
  client: PairedElectronClient,
  target: HostTerminal,
  marker: string
): Promise<void> {
  await client.page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error(`No pane mounted for ${id}`)
    }
    pane.terminal.focus()
    const textarea = pane.container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    textarea.focus()
  }, target.webTabId)
  await client.page.keyboard.type(marker)
  await client.page.keyboard.press('Enter')
  await expect.poll(() => readText(target.sinkPath), { timeout: 15_000 }).toContain(marker)
  await expect
    .poll(() => readPaneContent(client.page, target.webTabId), { timeout: 15_000 })
    .toContain(`LIVE:${marker}`)
}

async function moveHostAwayFromWorktree(page: Page, targetWorktreeId: string): Promise<string> {
  const alternateWorktreeId = await page.evaluate((targetId) => {
    const state = window.__store?.getState()
    const alternate = state?.allWorktrees().find((worktree) => worktree.id !== targetId)
    if (!state || !alternate) {
      return null
    }
    state.setActiveView('editor')
    state.setActiveWorktree(alternate.id)
    return alternate.id
  }, targetWorktreeId)
  if (!alternateWorktreeId) {
    throw new Error('Host fixture needs a second worktree for inactive-workspace restart coverage')
  }
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null))
    .toBe(alternateWorktreeId)
  return alternateWorktreeId
}

test('foregrounds a preserved daemon PTY after the paired host relaunches', async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both host launches.
{}, testInfo) => {
  test.setTimeout(360_000)
  const repoPath = seededRepoPathOrSkip()
  writeFileSync(backlogPath, '')
  const previousParkDelay = process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS
  process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = String(PARK_DELAY_MS)
  const session = createRestartSession(testInfo, {
    ORCA_DAEMON_STREAM_BACKLOG_FILE: backlogPath
  })
  let firstHost: ElectronApplication | null = null
  let secondHost: ElectronApplication | null = null
  let client: PairedElectronClient | null = null
  const terminals: HostTerminal[] = []
  try {
    const first = await session.launch()
    firstHost = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const daemonPid = readDaemonPid(session.userDataDir)
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(first.page),
      testInfo,
      'host-restart-background-sync'
    )
    await expect
      .poll(
        () =>
          client!.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000, message: 'Paired client never saw the host worktree' }
      )
      .toBe(true)

    const target = await createHostTerminal(client, worktreeId, 'target')
    const firstDecoy = await createHostTerminal(client, worktreeId, 'first-decoy')
    const parkingDecoy = await createHostTerminal(client, worktreeId, 'parking-decoy')
    terminals.push(target, firstDecoy, parkingDecoy)
    await openClientTab(client.page, worktreeId, target.webTabId)
    await expect
      .poll(() => readPaneContent(client!.page, target.webTabId), { timeout: 30_000 })
      .toContain('READY')
    await openClientTab(client.page, worktreeId, firstDecoy.webTabId)
    await openClientTab(client.page, worktreeId, parkingDecoy.webTabId)
    await waitForTabParked(client.page, target.webTabId, { parkDelayMs: PARK_DELAY_MS })

    const targetSuffix = target.ptyId.slice(-10)
    await expect
      .poll(
        () =>
          readBacklogEntries()
            .findLast((entry) => entry.backgroundedSessionIdSuffixes)
            ?.backgroundedSessionIdSuffixes?.includes(targetSuffix) ?? false,
        { timeout: 15_000, message: 'Daemon never retained the target background hint' }
      )
      .toBe(true)

    const alternateHostWorktreeId = await moveHostAwayFromWorktree(first.page, worktreeId)
    await session.close(firstHost)
    firstHost = null
    const foregroundEventStartMs = Date.now()
    const second = await session.launch()
    secondHost = second.app
    await second.page.waitForFunction(
      (expectedId) =>
        window.__store?.getState().workspaceSessionReady === true &&
        window.__store?.getState().activeWorktreeId === expectedId,
      alternateHostWorktreeId,
      { timeout: 30_000 }
    )
    expect(readDaemonPid(session.userDataDir), 'daemon must survive the host relaunch').toBe(
      daemonPid
    )
    await openClientTab(client.page, worktreeId, target.webTabId)
    await expect
      .poll(
        () =>
          client!.page.evaluate(async (selector) => {
            const response = await window.api.runtimeEnvironments.connect({ selector })
            return response.ok
          }, client!.environmentId),
        { timeout: 60_000, message: 'Paired client never reconnected to the relaunched host' }
      )
      .toBe(true)

    await waitForPaneConnected(client.page, target.webTabId)
    await expect
      .poll(
        () =>
          readBacklogEntries().some(
            (entry) =>
              (entry.atMs ?? 0) >= foregroundEventStartMs &&
              entry.event === 'setSessionBackground' &&
              entry.sessionIdSuffix === targetSuffix &&
              entry.background === false
          ),
        { timeout: 15_000, message: 'Relaunched host never foregrounded the preserved PTY' }
      )
      .toBe(true)
    await expectTerminalInteractive(client, target, 'x')
    target.handle = await findTerminalHandle(client, worktreeId, target.parentTabId)
    const restored = await callRuntime<{ terminal: { ptyId: string | null } }>(
      client.page,
      client.environmentId,
      'terminal.show',
      { terminal: target.handle }
    )
    expect(restored.terminal.ptyId, 'host inventory must preserve the daemon PTY identity').toBe(
      target.ptyId
    )

    const reconnectControl = await createHostTerminal(client, worktreeId, 'reconnect-control')
    terminals.push(reconnectControl)
    expect(reconnectControl.ptyId).not.toBe(target.ptyId)
    await openClientTab(client.page, worktreeId, reconnectControl.webTabId)
    await waitForPaneConnected(client.page, reconnectControl.webTabId)
    await expectTerminalInteractive(client, reconnectControl, 'y')
  } finally {
    if (client) {
      for (const terminal of terminals) {
        await callRuntime(client.page, client.environmentId, 'terminal.closeTab', {
          terminal: terminal.handle
        }).catch(() => undefined)
      }
      await client.dispose()
    }
    if (secondHost) {
      await session.close(secondHost)
    }
    if (firstHost) {
      await session.close(firstHost)
    }
    await session.dispose()
    if (previousParkDelay === undefined) {
      delete process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS
    } else {
      process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = previousParkDelay
    }
  }
})
