/**
 * E2E tests for keyboard focus after a terminal split.
 *
 * User Prompt:
 * - after splitting a pane with the shortcut, the new pane takes focus so I can type immediately
 * - "Focus New Split Pane" can be turned off to keep typing in the source pane
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  resolveActiveTabId,
  waitForActivePanePtyId,
  waitForPaneCount,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

const IS_MAC = process.platform === 'darwin'
const SPLIT_CHORD = IS_MAC ? 'Meta+d' : 'Control+Shift+d'

type FocusState = {
  activeLeafId: string | null
  focusedLeafId: string | null
  focusedIsHelperTextarea: boolean
}

// Why: a failed focus assertion is useless without naming the call that moved focus.
async function installFocusTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trace: { t: number; op: string; target: string; stack: string }[] = []
    const describe = (el: Element): string =>
      `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`
    for (const op of ['focus', 'blur'] as const) {
      const original = HTMLElement.prototype[op]
      HTMLElement.prototype[op] = function (this: HTMLElement, ...args: []) {
        trace.push({
          t: performance.now(),
          op,
          target: describe(this),
          stack: new Error('focus trace').stack ?? ''
        })
        return original.apply(this, args)
      }
    }
    Object.assign(window, { __focusTrace: trace })
  })
}

async function readFocusTrace(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify(Reflect.get(window, '__focusTrace') ?? [], null, 1))
}

async function waitThreeFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
  )
}

async function readFocusState(page: Page, tabId: string): Promise<FocusState> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const panes = manager?.getPanes() ?? []
    const active = document.activeElement
    const focusedPane = panes.find((pane) => active && pane.container.contains(active))
    return {
      activeLeafId: manager?.getActivePane?.()?.leafId ?? null,
      focusedLeafId: focusedPane?.leafId ?? null,
      focusedIsHelperTextarea: Boolean(active?.classList.contains('xterm-helper-textarea'))
    }
  }, tabId)
}

async function setFocusNewSplitPane(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(
    (enabled) => window.__store?.getState().updateSettings({ terminalFocusNewSplitPane: enabled }),
    enabled
  )
}

async function splitWithChord(page: Page): Promise<{ tabId: string; originalLeafId: string }> {
  const before = await waitForPaneIdentitySnapshot(page, 1)
  const originalLeafId = before.activeLeafId ?? before.panes[0].leafId
  await focusActiveTerminalInput(page)
  await installFocusTrace(page)
  await page.keyboard.press(SPLIT_CHORD)
  await waitForPaneCount(page, 2)
  await waitThreeFrames(page)
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('No active terminal tab after split')
  }
  return { tabId, originalLeafId }
}

// Why: keep the suite serial so headful pane tests never open multiple Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal split focus', () => {
  registerTerminalPaneMountReadiness()

  test('keyboard split puts DOM focus in the new pane and keeps it there', async ({ orcaPage }) => {
    await setFocusNewSplitPane(orcaPage, true)
    const { tabId, originalLeafId } = await splitWithChord(orcaPage)

    const state = await readFocusState(orcaPage, tabId)
    const trace = await readFocusTrace(orcaPage)
    expect(state.activeLeafId, `focus trace: ${trace}`).not.toBe(originalLeafId)
    expect(state.focusedLeafId, `focus trace: ${trace}`).toBe(state.activeLeafId)
    expect(state.focusedIsHelperTextarea, `focus trace: ${trace}`).toBe(true)

    const marker = `SPLIT_FOCUS_${Date.now()}`
    await waitForActivePanePtyId(orcaPage)
    await orcaPage.keyboard.type(`echo ${marker}\r`)
    await waitForTerminalOutput(orcaPage, marker)
  })

  test('split with Focus New Split Pane off keeps focus on the source pane', async ({
    orcaPage
  }) => {
    await setFocusNewSplitPane(orcaPage, false)
    const { tabId, originalLeafId } = await splitWithChord(orcaPage)

    const state = await readFocusState(orcaPage, tabId)
    const trace = await readFocusTrace(orcaPage)
    expect(state.activeLeafId, `focus trace: ${trace}`).toBe(originalLeafId)
    expect(state.focusedLeafId, `focus trace: ${trace}`).toBe(originalLeafId)
  })
})
