import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

async function installDelayedTerminalFocusSteals(
  page: Page,
  delaysMs: readonly number[]
): Promise<void> {
  await page.evaluate((delays) => {
    const focusTerminalAfterTitleFocus = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('pane-title-input')) {
        return
      }
      document.removeEventListener('focusin', focusTerminalAfterTitleFocus, true)
      for (const delay of delays) {
        window.setTimeout(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
          textarea?.focus()
        }, delay)
      }
    }
    document.addEventListener('focusin', focusTerminalAfterTitleFocus, true)
  }, delaysMs)
}

// Serialize headful scenarios; visible-window runs require an isolated display.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('Set Title still commits by blur after synthetic terminal focus steals', async ({
    orcaPage
  }) => {
    const title = `Post steal blur title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await installDelayedTerminalFocusSteals(orcaPage, [50, 150])
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(300)
    await titleInput.fill(title)
    await orcaPage
      .locator('.xterm:visible')
      .first()
      .click({ position: { x: 40, y: 60 } })

    await expect(titleInput).toHaveCount(0)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })
})
