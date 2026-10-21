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

/** Keeps the renderer busy for `ms`, as a window too busy to mount anything. */
async function stallRenderer(page: Page, ms: number): Promise<void> {
  await page.evaluate((stallMs) => {
    setTimeout(() => {
      const until = performance.now() + stallMs
      while (performance.now() < until) {
        // Busy renderer.
      }
    }, 0)
  }, ms)
}

function windowLeafIdsOf(page: Page, tabId: string): Promise<string[]> {
  return page.evaluate((id) => {
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
}

// Main writes the split and starts its terminal itself, so a busy window never holds the CLI up.
test('a CLI split of a parked tab answers promptly while the window is busy', async ({
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
  await stallRenderer(orcaPage, 8_000)
  const startedAt = Date.now()
  const outcome = await runCliSplit(userDataDir, source, 'echo started-by-main')
  const elapsedMs = Date.now() - startedAt
  await testInfo.attach('split-busy-window.json', {
    body: JSON.stringify({ elapsedMs, outcome }, null, 2),
    contentType: 'application/json'
  })
  expect(outcome).toEqual({ ok: true })
  expect(elapsedMs).toBeLessThan(6_000)
})

// The window is stalled past the old 10 s wait: main still starts the split's terminal, its
// command runs, and the window shows the pane from main's layout once it is free.
test('a CLI split runs its command while the window is stalled, and the window shows the pane', async ({
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
  await stallRenderer(orcaPage, 11_000)
  const marker = testInfo.outputPath(`split-ran-${Date.now()}`)
  mkdirSync(path.dirname(marker), { recursive: true })
  const outcome = await runCliSplit(userDataDir, source, `touch '${marker}'`)
  expect(outcome).toEqual({ ok: true })
  await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true)
  let tabLeafIds: string[] = []
  await expect
    .poll(async () => {
      const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
        worktree: `id:${worktreeId}`,
        limit: 200
      })
      tabLeafIds = listed.result.terminals
        .filter((t) => t.tabId === tabId)
        .map((t) => t.leafId)
        .sort()
      return tabLeafIds.length
    })
    .toBe(2)
  // Past the stall, the window holds both panes main has.
  await expect
    .poll(async () => (await windowLeafIdsOf(orcaPage, tabId)).sort(), { timeout: 30_000 })
    .toEqual(tabLeafIds)
})
