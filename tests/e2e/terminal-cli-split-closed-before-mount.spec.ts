import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const execFileAsync = promisify(execFile)
const PARKING_DELAY_MS = 500
const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

type SplitOutcome = { ok: true } | { ok: false; error: string }

async function runCliSplit(
  userDataDir: string,
  terminalHandle: string,
  command: string
): Promise<SplitOutcome> {
  const repoRoot = process.cwd()
  try {
    await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'config', 'scripts', 'orca-dev.mjs'),
        'terminal',
        'split',
        '--terminal',
        terminalHandle,
        '--command',
        command,
        '--json'
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
        timeout: 30_000
      }
    )
    return { ok: true }
  } catch (error) {
    const stdout = error instanceof Error && 'stdout' in error ? String(error.stdout) : ''
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : ''
    return { ok: false, error: [stdout, stderr].filter(Boolean).join('\n') }
  }
}

async function createActiveTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((id) => {
    const state = window.__store!.getState()
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', window.__store!.getState().activeWorktreeId)
    return tab.id
  }, worktreeId)
  await waitForActiveTerminalManager(page, 30_000)
  return tabId
}

async function handleFor(
  client: RuntimeClient,
  worktreeId: string,
  tabId: string
): Promise<string> {
  let handle = ''
  await expect
    .poll(async () => {
      const listed = await client
        .call<RuntimeTerminalListResult>('terminal.list', {
          worktree: `id:${worktreeId}`,
          limit: 200
        })
        .catch(() => null)
      handle = listed?.result.terminals.find((t) => t.tabId === tabId && t.connected)?.handle ?? ''
      return handle
    })
    .toBeTruthy()
  return handle
}

// Main closes the split's tab while the window is too busy to mount the split: the CLI hears so
// once the close lands, not after its 10 s wait.
test('a CLI split whose tab closes before it mounts answers promptly', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.skip(!LAYOUT_OWNER_BUILD, 'layout-owner build only')
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000)
  const tabId = await createActiveTab(orcaPage, worktreeId)
  const source = await handleFor(client, worktreeId, tabId)
  await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, { parkDelayMs: PARKING_DELAY_MS })
  await orcaPage.evaluate(() => {
    window.addEventListener(
      'orca-background-mount-terminal-worktree',
      () => {
        const until = performance.now() + 2_500
        while (performance.now() < until) {
          // Busy renderer.
        }
      },
      { once: true, capture: true }
    )
  })
  const startedAt = Date.now()
  const split = runCliSplit(userDataDir, source, 'echo never')
  // The CLI starts and main writes the pane while the window stalls on the split's mount.
  await new Promise((resolve) => setTimeout(resolve, 800))
  const closeStartedAt = Date.now()
  const closed = await client.call('terminal.closeTab', { terminal: source }).then(
    () => 'ok',
    (error: unknown) => String(error)
  )
  const outcome = await split
  const elapsedMs = Date.now() - startedAt
  const report = { closed, closeAfterMs: closeStartedAt - startedAt, elapsedMs, outcome }
  await testInfo.attach('split-closed-tab.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  expect(outcome.ok).toBe(false)
  // Failed because of the close, not some earlier CLI failure.
  expect(outcome.ok ? '' : outcome.error).toContain('split_pane_closed')
  expect(elapsedMs).toBeLessThan(6_000)
})

// The window is too busy to start the split's terminal within the CLI's 10 s: main takes the
// pane back, so the CLI's failure is the truth and the startup command never runs.
test('a CLI split whose terminal does not start within 10 s leaves no pane', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.skip(!LAYOUT_OWNER_BUILD, 'layout-owner build only')
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000)
  const tabId = await createActiveTab(orcaPage, worktreeId)
  const source = await handleFor(client, worktreeId, tabId)
  await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, { parkDelayMs: PARKING_DELAY_MS })
  await orcaPage.evaluate(() => {
    window.addEventListener(
      'orca-background-mount-terminal-worktree',
      () => {
        const until = performance.now() + 11_000
        while (performance.now() < until) {
          // Busy renderer.
        }
      },
      { once: true, capture: true }
    )
  })
  // A file the command writes: a terminal that ran it and was then killed still leaves it.
  const marker = testInfo.outputPath(`split-ran-${Date.now()}`)
  mkdirSync(path.dirname(marker), { recursive: true })
  const outcome = await runCliSplit(userDataDir, source, `touch '${marker}'`)
  // Past the stall: the window has handled the split and main's take-back.
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const tabTerminals = await client
    .call<RuntimeTerminalListResult>('terminal.list', { worktree: `id:${worktreeId}`, limit: 200 })
    .then((listed) => listed.result.terminals.filter((t) => t.tabId === tabId))
  const windowLeafIds = await orcaPage.evaluate((id) => {
    const collect = (node: unknown): string[] => {
      if (typeof node !== 'object' || node === null) {
        return []
      }
      if ('leafId' in node && typeof node.leafId === 'string') {
        return [node.leafId]
      }
      return [
        ...('first' in node ? collect(node.first) : []),
        ...('second' in node ? collect(node.second) : [])
      ]
    }
    return collect(window.__store?.getState().terminalLayoutsByTabId[id]?.root)
  }, tabId)
  const report = { outcome, tabTerminals: tabTerminals.map((t) => t.leafId), windowLeafIds }
  await testInfo.attach('split-taken-back.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  expect(outcome.ok ? '' : outcome.error).toContain(
    "split_pane_not_started: the new pane's terminal did not start within 10 s, so the pane was closed and its command was not run"
  )
  expect(tabTerminals).toHaveLength(1)
  expect(windowLeafIds).toEqual([tabTerminals[0]!.leafId])
  expect(existsSync(marker)).toBe(false)
})
