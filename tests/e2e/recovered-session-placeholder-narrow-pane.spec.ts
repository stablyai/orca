/**
 * The Recovered session placeholder stays readable at every terminal pane width down to the 50px
 * divider clamp, collapsing to one menu trigger where its labels no longer fit.
 */
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { test, expect } from './helpers/orca-app'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'
import {
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { HERMETIC_SHELL_ENV } from './helpers/electron-home-isolation'
import {
  captureGuardedFailureScreenshots,
  captureHiddenRendererScreenshot
} from './helpers/hidden-renderer-screenshot'
import { RECOVERY_SCREENSHOT_DIR } from './helpers/cross-machine-recovery-picker-fixtures'
import { recoveredSessionPlaceholder, unusableParts } from './helpers/recovered-session-placeholder'

const PANE_WIDTHS = [480, 320, 200, 160, 128, 96, 72, 50]

async function holdPaneWidth(page: Page, leafId: string, width: number): Promise<void> {
  // Why: headless drags never gain pointer capture, so write the flex a divider drag leaves.
  await page.evaluate(
    ({ leafId, width }) => {
      const selector = `.pane[data-leaf-id="${leafId}"]`
      const pane = document.querySelector<HTMLElement>(selector)!
      const sibling = document.querySelector<HTMLElement>(`${selector} + .pane-divider + .pane`)!
      const total = pane.getBoundingClientRect().width + sibling.getBoundingClientRect().width
      pane.style.flex = `${width} 1 0%`
      sibling.style.flex = `${total - width} 1 0%`
    },
    { leafId, width }
  )
  await expect
    .poll(() =>
      page.evaluate(
        (leafId) =>
          document.querySelector(`.pane[data-leaf-id="${leafId}"]`)!.getBoundingClientRect().width,
        leafId
      )
    )
    .toBeCloseTo(width, 0)
}

async function attachScreenshot(page: Page, testInfo: TestInfo, file: string): Promise<void> {
  const body = await captureHiddenRendererScreenshot(page, path.join(RECOVERY_SCREENSHOT_DIR, file))
  await testInfo.attach(file, { body, contentType: 'image/png' })
}

// Why: Playwright's own failure screenshot would bypass the identity guard.
test.use({ screenshot: 'off', orcaAppExtraEnv: HERMETIC_SHELL_ENV })

test.afterEach(async ({ orcaPage }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await captureGuardedFailureScreenshots([orcaPage], testInfo)
  }
})

test.describe('Recovered session placeholder in narrow panes', () => {
  registerTerminalPaneMountReadiness()

  test('stays readable down to the narrowest pane', async ({ orcaPage }, testInfo) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const { tabId } = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const [leafId] = await readTerminalPaneDomLeafOrder(orcaPage)
    const paneKey = makePaneKey(tabId, leafId)
    await orcaPage.evaluate(
      ({ paneKey, tabId }) => {
        const store = window.__store!
        const state = store.getState()
        const record: SleepingAgentSessionRecord = {
          paneKey,
          tabId,
          worktreeId: state.activeWorktreeId!,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'narrow-pane-session' },
          prompt: '',
          state: 'done',
          capturedAt: Date.now(),
          updatedAt: Date.now(),
          origin: 'recovery',
          recovery: { importKey: 'narrow-pane-import', sourcePaneKey: 'source-tab:source-leaf' }
        }
        store.setState({
          sleepingAgentSessionsByPaneKey: {
            ...state.sleepingAgentSessionsByPaneKey,
            [paneKey]: record
          }
        })
      },
      { paneKey, tabId }
    )
    const placeholder = recoveredSessionPlaceholder(orcaPage, paneKey)
    await expect(placeholder).toBeVisible()
    const trigger = placeholder.getByRole('button', { name: 'Recovered session' })
    const resume = placeholder.getByRole('button', { name: 'Resume' })

    for (const width of PANE_WIDTHS) {
      await holdPaneWidth(orcaPage, leafId, width)
      await expect(trigger.or(resume)).toBeVisible()
      expect({ width, unusable: await unusableParts(placeholder, 'pane') }).toEqual({
        width,
        unusable: []
      })
    }

    await expect(trigger).toBeVisible()
    await expect(resume).toHaveCount(0)
    await attachScreenshot(orcaPage, testInfo, 'placeholder-50px-compact.png')

    await trigger.click()
    const menu = orcaPage.getByRole('menu', { name: 'Recovered session' })
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Start shell instead' })).toBeVisible()
    expect(await unusableParts(menu, 'window')).toEqual([])
    await attachScreenshot(orcaPage, testInfo, 'placeholder-50px-menu.png')
    await orcaPage.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})
