import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSplit,
  RuntimeTerminalSummary
} from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import {
  readPaneIdentitySnapshot,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { parkHiddenTabBehindDecoy, waitForTabParked } from './helpers/terminal-hidden-parking'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

const execFileAsync = promisify(execFile)
const PARKING_DELAY_MS = 500
const HISTORICAL_SPLIT_TIMEOUT_MS = 10_000

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

type CliSplitResponse = {
  ok: true
  result: { split: RuntimeTerminalSplit }
}

type ActiveUiContext = {
  activeGroupId: string | null
  activeLeafId: string | null
  activeTabForWorktree: string | null
  activeTabId: string | null
  activeTabType: string | null
  activeWorktreeId: string | null
  domActiveTabId: string | null
  focusedTerminalTabId: string | null
}

async function resolveTerminal(
  client: RuntimeClient,
  worktreeId: string,
  tabId: string,
  leafId: string
): Promise<RuntimeTerminalSummary> {
  let resolved: RuntimeTerminalSummary | undefined
  await expect
    .poll(
      async () => {
        const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
          worktree: `id:${worktreeId}`,
          limit: 20,
          requireFreshPtyLiveness: true
        })
        resolved = listed.result.terminals.find(
          (terminal) => terminal.tabId === tabId && terminal.leafId === leafId
        )
        return resolved ? { connected: resolved.connected, writable: resolved.writable } : null
      },
      { timeout: 60_000, message: 'Renderer-owned split target never became runtime-visible' }
    )
    .toEqual({ connected: true, writable: true })
  if (!resolved) {
    throw new Error('Runtime terminal disappeared after becoming visible')
  }
  return resolved
}

async function readActiveUiContext(page: Page): Promise<ActiveUiContext> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const activeWorktreeId = state?.activeWorktreeId ?? null
    const activeTabId = state?.activeTabId ?? null
    const activePane = activeTabId
      ? window.__paneManagers?.get(activeTabId)?.getActivePane?.()
      : null
    const focused = document.activeElement
    return {
      activeGroupId: activeWorktreeId
        ? (state?.activeGroupIdByWorktree?.[activeWorktreeId] ?? null)
        : null,
      activeLeafId: activePane?.leafId ?? null,
      activeTabForWorktree: activeWorktreeId
        ? (state?.activeTabIdByWorktree?.[activeWorktreeId] ?? null)
        : null,
      activeTabId,
      activeTabType: state?.activeTabType ?? null,
      activeWorktreeId,
      domActiveTabId:
        document
          .querySelector('[data-testid="sortable-tab"][data-active="true"]')
          ?.getAttribute('data-tab-id') ?? null,
      focusedTerminalTabId:
        focused instanceof HTMLElement && focused.classList.contains('xterm-helper-textarea')
          ? (focused.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id') ??
            null)
          : null
    }
  })
}

async function runParkedSplitCli(
  userDataDir: string,
  terminalHandle: string
): Promise<{ elapsedMs: number; response: CliSplitResponse }> {
  const repoRoot = process.cwd()
  const startedAt = performance.now()
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'config', 'scripts', 'orca-dev.mjs'),
        'terminal',
        'split',
        '--terminal',
        terminalHandle,
        '--json'
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
        timeout: HISTORICAL_SPLIT_TIMEOUT_MS + 5_000
      }
    )
    return {
      elapsedMs: performance.now() - startedAt,
      response: JSON.parse(result.stdout) as CliSplitResponse
    }
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string }
    throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n'))
  }
}

async function activateTerminalTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Renderer store is unavailable')
      }
      state.setActiveView('terminal')
      state.setActiveWorktree(worktreeId)
      state.setActiveTabForWorktree(worktreeId, tabId)
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal')
    },
    { tabId, worktreeId }
  )
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 10_000,
      message: `Terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

async function enablePaneAccessibility(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const panes = window.__paneManagers?.get(id)?.getPanes?.() ?? []
    for (const pane of panes) {
      pane.terminal.options.screenReaderMode = true
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  }, tabId)
}

async function expectPaneKeyboardRoundTrip(
  page: Page,
  tabId: string,
  leafId: string,
  label: string
): Promise<void> {
  const nonce = randomUUID().replaceAll('-', '')
  const marker = `ORCA_PARKED_SPLIT_${label}_${nonce}`
  const command = `node -e "console.log('ORCA_PARKED_' + 'SPLIT_${label}_${nonce}')"`
  const pane = page.locator(
    `[data-terminal-tab-id=${JSON.stringify(tabId)}][data-terminal-layout-leaf-ids] .pane[data-leaf-id=${JSON.stringify(leafId)}]`
  )
  await pane.locator('.xterm').click({ force: true })
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(pane.locator('.xterm-accessibility-tree')).toContainText(marker, {
    timeout: 30_000
  })
}

test('CLI splits an exact cold-parked tab without stealing the active tab or focus', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  orcaPage.on('pageerror', (error) => pageErrors.push(String(error)))

  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const initial = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const targetTabId = initial.tabId
  const sourcePane = initial.panes[0]
  if (!sourcePane?.ptyId) {
    throw new Error('Initial terminal pane has no PTY identity')
  }

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000)
  const sourceTerminal = await resolveTerminal(client, worktreeId, targetTabId, sourcePane.leafId)

  await parkHiddenTabBehindDecoy(orcaPage, worktreeId, targetTabId, {
    parkDelayMs: PARKING_DELAY_MS
  })
  const decoyTabId = await getActiveTabId(orcaPage)
  if (!decoyTabId || decoyTabId === targetTabId) {
    throw new Error('Parking did not leave a distinct decoy tab active')
  }
  await orcaPage
    .locator(`[data-terminal-tab-id=${JSON.stringify(decoyTabId)}] .xterm:visible`)
    .click({ force: true })
  const contextBefore = await readActiveUiContext(orcaPage)
  expect(contextBefore).toMatchObject({
    activeTabForWorktree: decoyTabId,
    activeTabId: decoyTabId,
    activeTabType: 'terminal',
    activeWorktreeId: worktreeId,
    domActiveTabId: decoyTabId,
    focusedTerminalTabId: decoyTabId
  })
  const mountedBefore = await orcaPage.evaluate(() =>
    Array.from(window.__paneManagers?.keys() ?? []).sort()
  )
  expect(mountedBefore).not.toContain(targetTabId)

  const splitPromise = runParkedSplitCli(userDataDir, sourceTerminal.handle)
  let mountedDuringSplit: string[] = []
  await expect
    .poll(
      async () => {
        mountedDuringSplit = await orcaPage.evaluate(() =>
          Array.from(window.__paneManagers?.keys() ?? []).sort()
        )
        return mountedDuringSplit.includes(targetTabId)
      },
      { timeout: HISTORICAL_SPLIT_TIMEOUT_MS, message: 'CLI did not remount its parked target' }
    )
    .toBe(true)
  const splitRun = await splitPromise

  expect(mountedDuringSplit.filter((tabId) => !mountedBefore.includes(tabId))).toEqual([
    targetTabId
  ])
  expect(mountedBefore.filter((tabId) => !mountedDuringSplit.includes(tabId))).toEqual([])
  expect(splitRun.elapsedMs).toBeLessThan(HISTORICAL_SPLIT_TIMEOUT_MS)
  expect(splitRun.response).toMatchObject({
    ok: true,
    result: {
      split: {
        tabId: targetTabId,
        paneRuntimeId: sourcePane.numericPaneId
      }
    }
  })
  expect(splitRun.response.result.split.handle).toMatch(/^term_/)
  expect(await readActiveUiContext(orcaPage)).toEqual(contextBefore)

  await waitForTabParked(orcaPage, targetTabId, { parkDelayMs: PARKING_DELAY_MS })
  expect(await readActiveUiContext(orcaPage)).toEqual(contextBefore)

  await activateTerminalTab(orcaPage, worktreeId, targetTabId)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const revealed = await waitForPaneIdentitySnapshot(orcaPage, 2)
  const restoredSource = revealed.panes.find((pane) => pane.leafId === sourcePane.leafId)
  const createdPane = revealed.panes.find((pane) => pane.leafId !== sourcePane.leafId)
  expect(restoredSource).toMatchObject({ ptyId: sourcePane.ptyId })
  if (!createdPane?.ptyId) {
    throw new Error('Revealed split has no second PTY identity')
  }

  let listedAfterReveal: RuntimeTerminalSummary[] = []
  await expect
    .poll(async () => {
      const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
        worktree: `id:${worktreeId}`,
        limit: 20,
        requireFreshPtyLiveness: true
      })
      listedAfterReveal = listed.result.terminals.filter(
        (terminal) => terminal.tabId === targetTabId
      )
      return listedAfterReveal.map((terminal) => terminal.handle).sort()
    })
    .toEqual([sourceTerminal.handle, splitRun.response.result.split.handle].sort())
  expect(
    listedAfterReveal.find((terminal) => terminal.handle === sourceTerminal.handle)
  ).toMatchObject({
    leafId: sourcePane.leafId,
    ptyId: sourcePane.ptyId
  })
  expect(
    listedAfterReveal.find((terminal) => terminal.handle === splitRun.response.result.split.handle)
  ).toMatchObject({ leafId: createdPane.leafId, ptyId: createdPane.ptyId })

  const targetSurface = orcaPage.locator(
    `[data-terminal-tab-id=${JSON.stringify(targetTabId)}][data-terminal-layout-leaf-ids]`
  )
  await expect(targetSurface).toBeVisible()
  await expect(targetSurface.locator('.pane[data-leaf-id]')).toHaveCount(2)
  await expect(targetSurface.locator('.xterm:visible')).toHaveCount(2)
  await expect(
    targetSurface.locator(`.pane[data-leaf-id=${JSON.stringify(sourcePane.leafId)}]`)
  ).toBeVisible()
  await expect(
    targetSurface.locator(`.pane[data-leaf-id=${JSON.stringify(createdPane.leafId)}]`)
  ).toBeVisible()

  await enablePaneAccessibility(orcaPage, targetTabId)
  await expect(targetSurface.locator('.xterm-accessibility-tree')).toHaveCount(2)
  await expectPaneKeyboardRoundTrip(orcaPage, targetTabId, sourcePane.leafId, 'SOURCE')
  await expectPaneKeyboardRoundTrip(orcaPage, targetTabId, createdPane.leafId, 'CREATED')

  await testInfo.attach('parked-cli-split-final.png', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  expect(pageErrors).toEqual([])
  expect(await readPaneIdentitySnapshot(orcaPage)).toMatchObject({
    panes: revealed.panes,
    ptyIdsByLeafId: revealed.ptyIdsByLeafId,
    tabId: revealed.tabId
  })
})
