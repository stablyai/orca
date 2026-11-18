import type { Page } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { parkHiddenTabBehindDecoy } from './terminal-hidden-parking'
import { waitForPaneIdentitySnapshot } from '../input/terminal'
import { execInTerminal, waitForActiveTerminalManager } from '../layout/terminal-pane-operations'
import { getTerminalContent } from '../layout/terminal-pane-identity'
import { nodeTerminalCommand } from '../input/terminal-node-command'

const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

async function hasPtySession(page: Page, ptyId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const sessions = await window.api.pty.listSessions()
    return sessions.some((session) => session.id === id)
  }, ptyId)
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<void> {
  const tabId = await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
    return tab.id
  }, worktreeId)

  await waitForActiveTerminalManager(page, 30_000)
  expect((await waitForPaneIdentitySnapshot(page, 1)).tabId).toBe(tabId)
}

test('closing a parked terminal tab retires its exact PTY session', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const tabId = snapshot.tabId
  const ptyId = snapshot.panes[0]?.ptyId
  if (!ptyId) {
    throw new Error('active terminal pane did not bind a PTY')
  }

  const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toBeVisible()

  const marker = `PARKED_CLOSE_READY_${randomUUID()}`
  const keepAliveScript = `process.stdout.write(${JSON.stringify(`${marker}\n`)}); setInterval(() => {}, 1000)`
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand(['-e', keepAliveScript]))
  await expect
    .poll(() => getTerminalContent(orcaPage), {
      timeout: 10_000,
      message: 'long-lived terminal child did not print its ready marker'
    })
    .toContain(marker)
  await expect.poll(() => hasPtySession(orcaPage, ptyId), { timeout: 10_000 }).toBe(true)

  // Hide B most recently so it takes the warm exemption while decoy C makes A parkable.
  await createActiveTerminalTab(orcaPage, worktreeId)
  await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
    parkDelayMs: PARKING_DELAY_MS
  })
  // Require PTY survival through parking so early session death cannot satisfy close retirement.
  await expect.poll(() => hasPtySession(orcaPage, ptyId), { timeout: 10_000 }).toBe(true)

  await orcaPage.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    store.getState().closeTab(id)
  }, tabId)

  await expect
    .poll(() => hasPtySession(orcaPage, ptyId), {
      timeout: 15_000,
      message: `parked tab close did not retire PTY ${ptyId}`
    })
    .toBe(false)
  await expect(tab).toHaveCount(0)
})
