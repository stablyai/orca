import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { createRestartableHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { createPairedWebClientUrl } from './helpers/paired-web-client-url'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-headless-serve-browser-restart-'))
const fixturePath = path.join(scratch, 'terminal-echo.mjs')

writeFileSync(
  fixturePath,
  [
    "const label = process.argv[2] ?? 'terminal'",
    'process.stdout.write(`READY:${label}\\r\\n`)',
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) process.stdout.write(`LIVE:${label}:${line}\\r\\n`)',
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

function fixtureCommand(label: string): string {
  const command = [process.execPath, fixturePath, label]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

function readDaemonPid(userDataDir: string): number {
  const pidFile = path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`)
  if (!existsSync(pidFile)) {
    throw new Error('Headless serve daemon pid file is missing')
  }
  const value = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown }
  if (typeof value.pid !== 'number') {
    throw new Error('Headless serve daemon pid file did not contain a numeric pid')
  }
  return value.pid
}

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

async function waitForRuntimeReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const response = await window.api.runtime.call({ method: 'status.get' })
            return response.ok ? response._meta.runtimeId : null
          } catch {
            return null
          }
        }),
      {
        timeout: 30_000,
        message: 'Paired Web client runtime RPC never became callable'
      }
    )
    .not.toBeNull()
}

async function createTerminal(
  page: Page,
  worktreeId: string,
  label: string
): Promise<{ hostTabId: string; terminal: string; webTabId: string }> {
  const created = await callRuntime<{
    tab: { id: string; parentTabId: string; terminal: string | null }
  }>(page, 'session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command: fixtureCommand(label),
    activate: false,
    select: false,
    navigation: 'caller'
  })
  if (!created.tab.terminal) {
    throw new Error(`Headless serve did not publish the ${label} terminal`)
  }
  return {
    hostTabId: created.tab.parentTabId,
    terminal: created.tab.terminal,
    webTabId: toWebTerminalSurfaceTabId(created.tab.parentTabId)
  }
}

async function readHostPtyId(page: Page, terminal: string): Promise<string> {
  const shown = await callRuntime<{ terminal: { ptyId: string | null } }>(page, 'terminal.show', {
    terminal
  })
  if (!shown.terminal.ptyId) {
    throw new Error(`Headless serve terminal ${terminal} did not expose its daemon PTY id`)
  }
  return shown.terminal.ptyId
}

async function findHostTerminalHandle(
  page: Page,
  worktreeId: string,
  hostTabId: string
): Promise<string> {
  let terminal: string | null = null
  await expect
    .poll(
      async () => {
        const snapshot = await callRuntime<{
          tabs: { parentTabId?: string; terminal?: string | null; type: string }[]
        }>(page, 'session.tabs.list', { worktree: `id:${worktreeId}` })
        terminal =
          snapshot.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === hostTabId)
            ?.terminal ?? null
        return terminal
      },
      { timeout: 30_000, message: `Headless serve did not republish terminal tab ${hostTabId}` }
    )
    .not.toBeNull()
  if (!terminal) {
    throw new Error(`Headless serve did not republish terminal tab ${hostTabId}`)
  }
  return terminal
}

async function clickTerminalTab(page: Page, webTabId: string): Promise<void> {
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect(tab).toHaveAttribute('data-active', 'true')
}

test('reattaches a hidden terminal in the same browser document after headless serve restarts', async ({
  browser,
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const session = await createRestartableHeadlessPairedRuntimeHost()
  const firstHost = await session.start().catch(async (error) => {
    await session.dispose()
    throw error
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  try {
    if (!firstHost.offer.webClientUrl) {
      throw new Error('Headless serve did not publish a paired Web client URL')
    }
    await firstHost.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await page.goto(
      createPairedWebClientUrl(firstHost.offer.webClientUrl, {
        terminalParkingDelayMs: 180_000
      })
    )
    await page.locator('[data-worktree-sidebar]').waitFor({ state: 'visible', timeout: 30_000 })
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
        timeout: 30_000
      })
      .not.toBeNull()
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('Paired Web client did not receive the headless serve worktree')
    }
    await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    await waitForRuntimeReady(page)

    const target = await createTerminal(page, worktreeId, 'target')
    const decoy = await createTerminal(page, worktreeId, 'decoy')
    await clickTerminalTab(page, target.webTabId)
    await expect.poll(() => getTerminalContent(page), { timeout: 30_000 }).toContain('READY:target')
    await waitForActivePanePtyId(page, 30_000)
    const originalHostPtyId = await readHostPtyId(page, target.terminal)
    const beforeRestart = await page.evaluate(() => {
      const state = window.__store?.getState()
      const environmentId =
        state?.settings.activeRuntimeEnvironmentId ??
        state?.allWorktrees()[0]?.runtimeOwnerEnvironmentId ??
        state?.runtimeEnvironments[0]?.id ??
        null
      const status = environmentId
        ? state?.runtimeStatusByEnvironmentId.get(environmentId)
        : undefined
      document.documentElement.dataset.serveRestartSentinel = 'same-document'
      return {
        environmentId,
        runtimeId: status?.status?.runtimeId ?? null,
        connectionGeneration: status?.connectionGeneration ?? 0,
        diagnostics: {
          activeRuntimeEnvironmentId: state?.settings.activeRuntimeEnvironmentId ?? null,
          runtimeEnvironments: state?.runtimeEnvironments ?? [],
          runtimeStatuses: Array.from(state?.runtimeStatusByEnvironmentId.entries() ?? []),
          worktreeRuntimeOwnerEnvironmentId:
            state?.allWorktrees()[0]?.runtimeOwnerEnvironmentId ?? null
        }
      }
    })
    if (!beforeRestart.environmentId || !beforeRestart.runtimeId) {
      throw new Error(
        `Paired Web client did not publish its initial runtime identity: ${JSON.stringify(beforeRestart.diagnostics)}`
      )
    }

    await clickTerminalTab(page, decoy.webTabId)
    await expect.poll(() => getTerminalContent(page), { timeout: 30_000 }).toContain('READY:decoy')
    await expect
      .poll(
        () =>
          page.evaluate((tabId) => {
            const pane = window.__paneManagers?.get(tabId)?.getPanes?.()[0]
            return Boolean(pane?.container?.isConnected)
          }, target.webTabId),
        { message: 'Hidden target terminal was parked instead of remaining mounted' }
      )
      .toBe(true)

    const daemonPid = readDaemonPid(session.userDataDir)
    await session.stop()
    await expect
      .poll(
        () =>
          page.evaluate((tabId) => {
            const pane = window.__paneManagers?.get(tabId)?.getPanes?.()[0]
            return pane?.container?.dataset?.ptyRecoveryState ?? null
          }, target.webTabId),
        {
          timeout: 90_000,
          message: 'Hidden target terminal never reached the bounded disconnected state'
        }
      )
      .toBe('disconnected')

    await session.start()
    expect(readDaemonPid(session.userDataDir)).toBe(daemonPid)
    expect(page.isClosed()).toBe(false)
    expect(
      await page.evaluate(() => document.documentElement.dataset.serveRestartSentinel ?? null)
    ).toBe('same-document')
    await expect
      .poll(
        () =>
          page.evaluate(
            (environmentId) =>
              window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)?.status
                ?.runtimeId ?? null,
            beforeRestart.environmentId
          ),
        {
          timeout: 60_000,
          message: 'Paired Web client did not observe the replacement serve runtime id'
        }
      )
      .not.toBe(beforeRestart.runtimeId)
    await expect
      .poll(
        () =>
          page.evaluate(
            (environmentId) =>
              window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)
                ?.connectionGeneration ?? 0,
            beforeRestart.environmentId
          ),
        {
          timeout: 60_000,
          message: 'Paired Web client did not advance its runtime connection generation'
        }
      )
      .toBeGreaterThan(beforeRestart.connectionGeneration)

    await clickTerminalTab(page, target.webTabId)
    await waitForActivePanePtyId(page, 30_000)
    const marker = `after-restart-${Date.now()}`
    const textarea = page.locator('.xterm-helper-textarea:visible').first()
    await textarea.focus()
    await page.keyboard.type(marker)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`LIVE:target:${marker}`)
    const currentTargetHandle = await findHostTerminalHandle(page, worktreeId, target.hostTabId)
    expect(await readHostPtyId(page, currentTargetHandle)).toBe(originalHostPtyId)
  } finally {
    await context.close().catch(() => undefined)
    await session.dispose()
  }
})
