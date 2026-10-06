/**
 * A paired client's ACTIVE remote terminal must keep accepting keyboard input after the desktop host
 * quits (daemon survives) and relaunches. The relaunched host's graph publication is held so the
 * client's reconnect deterministically meets the host before its renderer has published any tabs —
 * the window a slow (e.g. Windows) host start leaves open in the field.
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-host-quit-reconnect-input.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
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
import {
  holdWindowGraphPublication,
  releaseWindowGraphPublication
} from './helpers/hold-window-graph-publication'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-host-quit-input-'))
const fixturePath = path.join(scratch, 'paired-host-quit-terminal.mjs')

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
    ? // Why: the isolated Windows profile starts PowerShell, which parses a leading quoted path as a string, not a command.
      `& ${command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')}`
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pid field is checked below.
  const value = JSON.parse(
    readFileSync(path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`), 'utf8')
  ) as { pid?: unknown }
  if (typeof value.pid !== 'number') {
    throw new Error('Daemon pid file did not contain a numeric pid')
  }
  return value.pid
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only RPC result shape.
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
      state?.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
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

type PaneProbe = {
  content: string
  ptyId: string | null
  recovery: string | null
  banner: string | null
}

async function readPane(page: Page, webTabId: string): Promise<PaneProbe> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return {
      content: pane?.serializeAddon?.serialize?.() ?? '',
      ptyId: pane?.container.dataset.ptyId ?? null,
      recovery: pane?.container.dataset.ptyRecoveryState ?? null,
      banner:
        document
          .querySelector('[data-terminal-remote-runtime-reconnect-banner]')
          ?.getAttribute('data-terminal-remote-runtime-reconnect-banner') ?? null
    }
  }, webTabId)
}

async function typeIntoPane(page: Page, webTabId: string, text: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error(`No pane mounted for ${id}`)
    }
    pane.terminal.focus()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm always renders its helper textarea.
    const textarea = pane.container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    textarea.focus()
  }, webTabId)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function expectTerminalInteractive(
  page: Page,
  target: HostTerminal,
  marker: string
): Promise<void> {
  await typeIntoPane(page, target.webTabId, marker)
  try {
    await expect.poll(() => readText(target.sinkPath), { timeout: 15_000 }).toContain(marker)
    await expect
      .poll(async () => (await readPane(page, target.webTabId)).content, { timeout: 15_000 })
      .toContain(`LIVE:${marker}`)
  } catch (error) {
    const probe = await readPane(page, target.webTabId)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Pane probe: ${JSON.stringify({ ...probe, content: probe.content.slice(-400) })}\n` +
        `Host PTY sink: ${JSON.stringify(readText(target.sinkPath))}`
    )
  }
}

test('an active remote terminal accepts input after the host app quits and relaunches', async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both host launches.
{}, testInfo) => {
  test.setTimeout(360_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
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
      'host-quit-reconnect-input'
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
    terminals.push(target)
    await openClientTab(client.page, worktreeId, target.webTabId)
    await expect
      .poll(async () => (await readPane(client!.page, target.webTabId)).content, {
        timeout: 30_000
      })
      .toContain('READY')
    await expectTerminalInteractive(client.page, target, 'before')

    await session.close(firstHost)
    firstHost = null
    await expect
      .poll(async () => (await readPane(client!.page, target.webTabId)).banner, {
        timeout: 30_000,
        message: 'Client never showed the reconnect overlay after the host quit'
      })
      .not.toBeNull()
    const second = await session.launch({ beforeFirstWindow: holdWindowGraphPublication })
    secondHost = second.app
    expect(readDaemonPid(session.userDataDir), 'daemon must survive the host relaunch').toBe(
      daemonPid
    )
    // Why bounded: a fixed client settles out of recovery or keeps waiting; either way release the hold.
    await expect
      .poll(
        async () => {
          const { recovery } = await readPane(client!.page, target.webTabId)
          return recovery === 'recovering' || recovery === 'backoff' ? null : recovery
        },
        { timeout: 20_000 }
      )
      .not.toBeNull()
      .catch(() => undefined)
    // Why: proves the hold beat the host's first publication, so the client really met an unpublished host.
    const heldList = await callRuntime<{ publicationEpoch: string; tabs: unknown[] }>(
      client.page,
      client.environmentId,
      'session.tabs.list',
      { worktree: `id:${worktreeId}` }
    )
    expect(heldList.publicationEpoch.startsWith('none'), JSON.stringify(heldList)).toBe(true)
    expect(heldList.tabs).toEqual([])
    expect(
      await releaseWindowGraphPublication(second.app),
      'the relaunched host must not have published a graph before the client settled'
    ).toBe(0)
    await second.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      undefined,
      { timeout: 30_000 }
    )
    await expect
      .poll(
        async () =>
          (
            await callRuntime<{ tabs: { type: string; parentTabId?: string }[] }>(
              client!.page,
              client!.environmentId,
              'session.tabs.list',
              { worktree: `id:${worktreeId}` }
            )
          ).tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === target.parentTabId),
        { timeout: 30_000, message: 'Relaunched host never republished the target surface' }
      )
      .toBe(true)
    // No manual connect: the client must recover on its own, as in the field.
    await expect
      .poll(async () => (await readPane(client!.page, target.webTabId)).banner, {
        timeout: 90_000,
        message: 'Reconnect overlay never cleared'
      })
      .toBeNull()
    await expectTerminalInteractive(client.page, target, 'after')
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
  }
})
