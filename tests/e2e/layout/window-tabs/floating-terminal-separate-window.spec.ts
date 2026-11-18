import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'

const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'

test('opens the active floating terminal in a separate window', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tabId = await orcaPage.evaluate(async (worktreeId) => {
    const store = window.__store!
    await store.getState().updateSettings({ floatingTerminalEnabled: true })
    const tab = store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
    store.setState({ floatingWorkspacePanelOpen: true })
    return tab.id
  }, FLOATING_WORKTREE_ID)
  const panel = orcaPage.locator(OPEN_PANEL_SELECTOR)
  await expect(panel).toBeVisible()
  await panel.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).click()
  const readPtyId = (): Promise<string | null> =>
    orcaPage.evaluate(
      (id) => window.__paneManagers?.get(id)?.getActivePane()?.container.dataset.ptyId ?? null,
      tabId
    )
  await expect.poll(readPtyId).not.toBeNull()
  const ptyId = await readPtyId()

  const windowPromise = electronApp.waitForEvent('window')
  await panel.getByRole('button', { name: 'Open in separate window' }).click()
  const popout = await windowPromise
  expect(new URL(popout.url()).searchParams.get('ptyId')).toBe(ptyId)
  await expect(orcaPage.locator(OPEN_PANEL_SELECTOR)).toHaveCount(0)

  const preview = popout.locator('[data-agent-terminal-preview]')
  await expect(preview.locator('.xterm-helper-textarea')).toBeFocused()
  const marker = `separate-window-${Date.now()}`
  // The output "ok-<marker>" never appears in the typed command, so seeing it proves the shell ran it.
  await popout.keyboard.type(`printf '%s-%s\\n' ok ${marker}`)
  await popout.keyboard.press('Enter')
  await expect(preview).toContainText(`ok-${marker}`)

  // The pop-out is the same session: reopening the floating workspace shows what was typed there.
  await orcaPage.evaluate(() => window.__store!.setState({ floatingWorkspacePanelOpen: true }))
  await expect(panel).toBeVisible()
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ id, text }) =>
          window.__paneManagers
            ?.get(id)
            ?.getActivePane()
            ?.serializeAddon?.serialize()
            .includes(text) ?? false,
        { id: tabId, text: `ok-${marker}` }
      )
    )
    .toBe(true)
})
