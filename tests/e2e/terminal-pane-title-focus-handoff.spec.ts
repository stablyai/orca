/**
 * E2E tests for the Set Title editor surviving focus handoffs: xterm stealing
 * focus back, early blurs, and blur-commit behavior.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { splitActiveTerminalPane, waitForPaneCount } from './helpers/terminal'
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

// Why: keep the suite serial so the headful pane tests never ask Playwright to
// open multiple visible Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('Set Title input stays open when clicked in a split terminal', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()

    // Why: overlay controls own the title strip. Clicking the already-open
    // title input must not leak through to xterm and flash the editor closed.
    await titleInput.evaluate((input) => {
      const pointerInit: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse'
      }
      input.dispatchEvent(new PointerEvent('pointerdown', pointerInit))
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new PointerEvent('pointerup', pointerInit))
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect
      .poll(
        () => titleInput.evaluate((input) => input.isConnected && document.activeElement === input),
        { timeout: 1_000 }
      )
      .toBe(true)

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives an early blur during first focus handoff', async ({ orcaPage }) => {
    await openTerminalContextMenu(orcaPage)
    await orcaPage.evaluate(() => {
      const blurOnFirstTitleFocus = (event: FocusEvent): void => {
        const target = event.target
        if (
          !(target instanceof HTMLInputElement) ||
          !target.classList.contains('pane-title-input')
        ) {
          return
        }
        document.removeEventListener('focusin', blurOnFirstTitleFocus, true)
        queueMicrotask(() => target.blur())
      }
      document.addEventListener('focusin', blurOnFirstTitleFocus, true)
    })
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(250)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives delayed terminal focus handoffs', async ({ orcaPage }) => {
    await openTerminalContextMenu(orcaPage)
    await installDelayedTerminalFocusSteals(orcaPage, [50, 150, 300])
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(600)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives delayed terminal focus handoffs in a split pane', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    await openTerminalContextMenu(orcaPage)
    await installDelayedTerminalFocusSteals(orcaPage, [50, 150, 300])
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(600)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title preserves draft text across terminal focus steals', async ({ orcaPage }) => {
    const draftTitle = `Draft title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(draftTitle)

    await orcaPage.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    })

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(titleInput).toHaveValue(draftTitle)
  })

  test('Set Title does not submit when synthetic focus restore fails', async ({ orcaPage }) => {
    const draftTitle = `Blocked focus title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(draftTitle)
    await titleInput.evaluate((input) => {
      input.focus = () => {}
    })

    await orcaPage.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    })

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toHaveValue(draftTitle)
    await expect(orcaPage.locator('.pane-title-text', { hasText: draftTitle })).toHaveCount(0)
  })

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
