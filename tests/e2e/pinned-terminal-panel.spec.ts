/**
 * E2E: pinned terminal panels — settings-driven sidebar entries hosting
 * persistent PTY terminals (nvtop/btop/watch style observability commands).
 *
 * E2E, not a store unit test, because the interesting behavior is the IPC
 * round-trip a slice test cannot reach: the settings sanitizer in the main
 * process, the real PTY spawn on first visit (lazy — configured panels must
 * not spawn shells at boot), and the startup command actually executing in
 * the terminal the user sees.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getStoreState } from './helpers/store'

const PANEL_MARKER = 'PINNED_PANEL_E2E_MARKER'

test('pinned terminal panel: sidebar entry, lazy PTY spawn, command output, close restores view', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  // Seed a panel through the real settings pipeline (renderer -> main-process
  // sanitizer -> broadcast), not by poking renderer state directly.
  await orcaPage.evaluate((marker) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().updateSettings({
      pinnedTerminalPanels: [{ id: 'e2e-panel-1', title: 'E2E Panel', command: `echo ${marker}` }]
    })
  }, PANEL_MARKER)

  // The sanitized panel round-trips into settings.
  await expect
    .poll(
      async () =>
        getStoreState<{ id: string }[] | undefined>(orcaPage, 'settings.pinnedTerminalPanels').then(
          (panels) => panels?.length ?? 0
        ),
      { timeout: 10_000 }
    )
    .toBe(1)

  // Sidebar shows the panel entry (render-layer proof).
  const sidebarEntry = orcaPage.getByRole('button', { name: 'E2E Panel' })
  await expect(sidebarEntry).toBeVisible({ timeout: 10_000 })

  // Lazy spawn: merely configuring the panel must not create its tab.
  const tabsBeforeVisit = await orcaPage.evaluate(() => {
    const store = window.__store
    return store
      ? (store.getState().tabsByWorktree['global-pinned-terminal-panels'] ?? []).length
      : -1
  })
  expect(tabsBeforeVisit).toBe(0)

  // Visit the panel: view flips, terminal mounts, startup command ran.
  await sidebarEntry.click()
  await expect
    .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 10_000 })
    .toBe('terminal-panel')
  const panelHost = orcaPage.locator('[data-pinned-terminal-panel-id="e2e-panel-1"]')
  await expect(panelHost).toBeVisible({ timeout: 10_000 })
  await expect(panelHost.locator('.xterm')).toBeVisible({ timeout: 15_000 })
  // The PTY executed the configured command — its output is on screen.
  await expect(panelHost).toContainText(PANEL_MARKER, { timeout: 20_000 })

  // Close returns to the previous top-level view and the panel page hides.
  await orcaPage.getByRole('button', { name: 'Close panel' }).click()
  await expect
    .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 10_000 })
    .toBe('terminal')
  await expect(panelHost).not.toBeVisible({ timeout: 10_000 })
})
