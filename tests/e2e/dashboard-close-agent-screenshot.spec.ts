/**
 * TEMPORARY screenshot spec for the close-agent-session feature.
 *
 * Captures real UI screenshots of:
 *   01 — sidebar agent row hover revealing the Square "close session" button
 *   02 — sidebar CloseAgentSessionDialog (cancelled, session kept alive)
 *   03 — pop-out dashboard kanban card hover revealing the close X
 *   04 — pop-out close-session confirm Dialog (cancelled)
 *
 * Run:
 *   pnpm exec electron-vite build --mode e2e   (once)
 *   SKIP_BUILD=1 pnpm run test:e2e tests/e2e/dashboard-close-agent-screenshot.spec.ts
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'

const SCREENSHOT_DIR = path.join(process.cwd(), 'out', 'close-agent-screenshots')

test('close-agent-session screenshots', async ({ orcaPage, electronApp }) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  // Why: the close-session button only exists on DashboardAgentRow (full
  // display mode), and the sidebar list only renders when the worktree card
  // shows inline agents — neither is the E2E default.
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.toggleWorktreeCardProperty('inline-agents')
    }
    state.setAgentActivityDisplayMode('full')
  })

  // Live "working" agent row via the synthetic hook endpoint.
  await waitForActivePanePtyId(orcaPage)
  const endpoint = await readHookEndpoint(electronApp)
  const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
  const prompt = `close-agent-screenshot-${Date.now()}`
  await emitCodexHookStatus(endpoint, { paneKey, worktreeId, state: 'working', prompt })

  const agentsGroup = orcaPage.getByRole('group', { name: 'Agents' }).first()
  const closeSessionButton = orcaPage.getByRole('button', { name: 'Close agent session' }).first()
  await expect(closeSessionButton).toBeAttached({ timeout: 30_000 })

  const agentRow = orcaPage
    .locator('div[class*="group/agent-row"]')
    .filter({ has: closeSessionButton })
    .first()

  // Screenshot 01 — hover the sidebar row so the Square close button fades in.
  await agentRow.hover()
  await expect(closeSessionButton).toHaveCSS('opacity', '1', { timeout: 5_000 })
  const worktreeCard = orcaPage.locator('[role="option"]').filter({ has: agentsGroup }).first()
  await worktreeCard.screenshot({ path: path.join(SCREENSHOT_DIR, '01-sidebar-row-hover.png') })

  // Screenshot 02 — click opens the confirm dialog; cancel afterwards.
  await closeSessionButton.click()
  const sidebarDialog = orcaPage.getByRole('dialog')
  await expect(sidebarDialog.getByText('Close agent session?')).toBeVisible({ timeout: 10_000 })
  // Why: let the Radix fade/zoom-in finish or the dialog captures washed out.
  await expect(sidebarDialog).toHaveCSS('opacity', '1', { timeout: 5_000 })
  await orcaPage.screenshot({ path: path.join(SCREENSHOT_DIR, '02-sidebar-confirm-dialog.png') })
  await sidebarDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(sidebarDialog).toBeHidden({ timeout: 5_000 })

  // Pop-out dashboard: enable the experimental setting, then open the window.
  await orcaPage.evaluate(async () => {
    const settings = (await window.api.settings.set({
      experimentalAgentDashboardPopout: true
    })) as Record<string, unknown>
    window.__store?.setState({ settings })
  })
  await orcaPage.evaluate(() => window.api.dashboard.openPopout())

  let popoutPage: Page | null = null
  await expect
    .poll(
      async () => {
        popoutPage = electronApp.windows().find((w) => w.url().includes('popout.html')) ?? null
        return popoutPage !== null
      },
      { timeout: 15_000, message: 'dashboard pop-out window did not open' }
    )
    .toBe(true)
  if (!popoutPage) {
    throw new Error('dashboard pop-out window did not open')
  }
  await popoutPage.waitForLoadState('domcontentloaded')

  // Why: the close control is a span with role="button" (nested buttons are
  // invalid HTML); the dialog's confirm is a real <button>, so scope by tag.
  const cardCloseControl = popoutPage
    .locator('span[role="button"][aria-label="Close session"]')
    .first()
  await expect(cardCloseControl).toBeAttached({ timeout: 30_000 })
  const kanbanCard = cardCloseControl.locator('xpath=ancestor::button[1]')

  // Screenshot 03 — hover the kanban card so the close X replaces the state dot.
  await kanbanCard.hover()
  await expect(cardCloseControl).toHaveCSS('opacity', '1', { timeout: 5_000 })
  await popoutPage.screenshot({ path: path.join(SCREENSHOT_DIR, '03-popout-card-hover.png') })

  // Screenshot 04 — click opens the confirm dialog in the pop-out; cancel.
  // Center click: regression cover for the state dot swallowing clicks before
  // it got pointer-events-none.
  await cardCloseControl.click()
  const popoutDialog = popoutPage.getByRole('dialog')
  await expect(popoutDialog.getByText('Close agent session?')).toBeVisible({ timeout: 10_000 })
  // Why: let the Radix fade/zoom-in finish or the dialog captures washed out.
  await expect(popoutDialog).toHaveCSS('opacity', '1', { timeout: 5_000 })
  await popoutPage.screenshot({ path: path.join(SCREENSHOT_DIR, '04-popout-confirm-dialog.png') })
  await popoutDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(popoutDialog).toBeHidden({ timeout: 5_000 })
})
