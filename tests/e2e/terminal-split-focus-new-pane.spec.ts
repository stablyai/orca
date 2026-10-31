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

const SPLIT_CHORD = process.platform === 'darwin' ? 'Meta+d' : 'Control+Shift+d'

async function focusedLeafId(page: Parameters<typeof focusActiveTerminalInput>[0], tabId: string) {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const active = document.activeElement
    return (
      manager?.getPanes().find((pane) => active && pane.container.contains(active))?.leafId ?? null
    )
  }, tabId)
}

test.describe.configure({ mode: 'serial' })
test.describe('Terminal split focus', () => {
  registerTerminalPaneMountReadiness()

  test('keyboard split focuses the new pane so typing lands there', async ({ orcaPage }) => {
    const before = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const originalLeafId = before.activeLeafId ?? before.panes[0].leafId
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(SPLIT_CHORD)
    await waitForPaneCount(orcaPage, 2)

    const tabId = await resolveActiveTabId(orcaPage)
    const after = await waitForPaneIdentitySnapshot(orcaPage, 2)
    expect(after.activeLeafId).not.toBe(originalLeafId)
    expect(await focusedLeafId(orcaPage, tabId ?? '')).toBe(after.activeLeafId)

    const marker = `SPLIT_FOCUS_${Date.now()}`
    await waitForActivePanePtyId(orcaPage)
    await orcaPage.keyboard.type(`echo ${marker}\r`)
    await waitForTerminalOutput(orcaPage, marker)
  })

  test('Focus New Split Pane off keeps the source pane focused', async ({ orcaPage }) => {
    await orcaPage.evaluate(() =>
      window.__store?.getState().updateSettings({ terminalFocusNewSplitPane: false })
    )
    const before = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const originalLeafId = before.activeLeafId ?? before.panes[0].leafId
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(SPLIT_CHORD)
    await waitForPaneCount(orcaPage, 2)

    const tabId = await resolveActiveTabId(orcaPage)
    const after = await waitForPaneIdentitySnapshot(orcaPage, 2)
    expect(after.activeLeafId).toBe(originalLeafId)
    expect(await focusedLeafId(orcaPage, tabId ?? '')).toBe(originalLeafId)
  })
})
