import { test, expect } from './helpers/orca-app'
import {
  readPaneIdentitySnapshot,
  splitActiveTerminalPane,
  waitForPaneIdentitySnapshot,
  waitForPaneCount
} from './helpers/terminal'
import { setPaneTitleFromTerminalMenu } from './helpers/terminal-pane-title-actions'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('Set Title strip accepts file-path drops without changing the active pane', async ({
    orcaPage
  }) => {
    const title = `Drop target title ${Date.now()}`
    const droppedPath = `/tmp/title-drop-${Date.now()}.txt`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before split')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const splitSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const otherPane = splitSnapshot.panes.find((pane) => pane.leafId !== titledLeafId)
    if (!otherPane) {
      throw new Error('No inactive pane found for title-strip drop test')
    }

    await orcaPage.evaluate(
      ({ tabId, paneId }) => {
        window.__paneManagers?.get(tabId)?.setActivePane(paneId, { focus: false })
      },
      { tabId: splitSnapshot.tabId, paneId: otherPane.numericPaneId }
    )
    await expect
      .poll(async () => (await readPaneIdentitySnapshot(orcaPage))?.activeLeafId ?? null)
      .toBe(otherPane.leafId)

    const titleBar = orcaPage.locator('.pane-title-bar', { hasText: title }).first()
    await expect(titleBar).toHaveAttribute('data-os-file-drop-owner', '')
    await expect(titleBar).toHaveAttribute('data-terminal-tab-id', splitSnapshot.tabId)

    await titleBar.evaluate((element, path) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/x-orca-file-path', path)
      // Internal drops are refused without the source owner an Explorer drag records.
      dataTransfer.setData(
        'application/x-orca-workspace-file-source',
        JSON.stringify({
          executionHostId: 'local',
          workspaceId: window.__store?.getState().activeWorktreeId,
          version: 1
        })
      )
      element.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
      )
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
      )
    }, droppedPath)

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            ({ tabId, targetLeafId, otherLeafId, droppedPath }) => {
              const manager = window.__paneManagers?.get(tabId)
              const panes = manager?.getPanes() ?? []
              const content = (leafId: string) =>
                panes.find((pane) => pane.leafId === leafId)?.serializeAddon?.serialize() ?? ''
              return {
                activeLeafId: manager?.getActivePane()?.leafId ?? null,
                targetHasPath: content(targetLeafId).includes(droppedPath),
                otherHasPath: content(otherLeafId).includes(droppedPath)
              }
            },
            {
              tabId: splitSnapshot.tabId,
              targetLeafId: titledLeafId,
              otherLeafId: otherPane.leafId,
              droppedPath
            }
          ),
        { timeout: 5_000, message: 'Title-strip drop changed selection or missed its target' }
      )
      .toEqual({ activeLeafId: otherPane.leafId, targetHasPath: true, otherHasPath: false })
  })
})
