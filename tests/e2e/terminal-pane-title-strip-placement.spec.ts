/**
 * E2E tests for the Set Title overlay strip staying attached to its pane across
 * activation, file drops, moves, and drags.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  moveTerminalPaneByLeafId,
  readPaneIdentitySnapshot,
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForPaneIdentitySnapshot,
  waitForPaneCount,
  getTerminalContent
} from './helpers/terminal'
import { setPaneTitleFromTerminalMenu } from './helpers/terminal-pane-title-actions'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

async function expectPaneTitleAttachedToLeaf(
  page: Page,
  title: string,
  leafId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ title, leafId }) => {
            const titleBar = Array.from(
              document.querySelectorAll<HTMLElement>('.pane-title-bar')
            ).find((element) => element.textContent?.includes(title))
            const pane = document.querySelector<HTMLElement>(`.pane[data-leaf-id="${leafId}"]`)
            if (!titleBar || !pane) {
              return false
            }
            const titleRect = titleBar.getBoundingClientRect()
            const paneRect = pane.getBoundingClientRect()
            return (
              Math.abs(titleRect.left - paneRect.left) < 1 &&
              Math.abs(titleRect.top - paneRect.top) < 1 &&
              Math.abs(titleRect.width - paneRect.width) < 1
            )
          },
          { title, leafId }
        ),
      {
        timeout: 5_000,
        message: 'Pane title overlay did not stay attached to its pane'
      }
    )
    .toBe(true)
}

// Why: keep the suite serial so the headful pane tests never ask Playwright to
// open multiple visible Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('Set Title strip activates its pane and accepts file-path drops', async ({ orcaPage }) => {
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
    await expect(titleBar).toHaveAttribute('data-native-file-drop-target', 'terminal')
    await expect(titleBar).toHaveAttribute('data-terminal-tab-id', splitSnapshot.tabId)

    await titleBar.evaluate((element, path) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/x-orca-file-path', path)
      element.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
      )
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
      )
    }, droppedPath)

    await expect
      .poll(async () => (await readPaneIdentitySnapshot(orcaPage))?.activeLeafId ?? null, {
        timeout: 5_000,
        message: 'Title-strip drop did not activate the titled pane'
      })
      .toBe(titledLeafId)
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(droppedPath), {
        timeout: 5_000,
        message: 'Title-strip drop did not paste into the titled pane terminal'
      })
      .toBe(true)
  })

  test('Set Title overlay follows its pane after same-count pane move', async ({ orcaPage }) => {
    const title = `Moved overlay title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before move')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const beforeMove = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const target = beforeMove.panes.find((pane) => pane.leafId !== titledLeafId)
    if (!target) {
      throw new Error('No target pane found for titled pane move')
    }
    const beforeOrder = await readTerminalPaneDomLeafOrder(orcaPage)

    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)
    await moveTerminalPaneByLeafId(orcaPage, titledLeafId, target.leafId, 'right')

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(orcaPage), {
        timeout: 10_000,
        message: 'Pane move did not update DOM order'
      })
      .not.toEqual(beforeOrder)
    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)
  })

  test('Set Title keeps the pane drag handle available over the title strip', async ({
    orcaPage
  }) => {
    const title = `Draggable title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before split')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)

    const titleTopHit = await orcaPage.evaluate(
      ({ title, titledLeafId }) => {
        const titleBar = Array.from(document.querySelectorAll<HTMLElement>('.pane-title-bar')).find(
          (element) => element.textContent?.includes(title)
        )
        const titleDragHandle =
          titleBar.querySelector<HTMLElement>('.pane-title-drag-handle') ?? null
        const pane = document.querySelector<HTMLElement>(`.pane[data-leaf-id="${titledLeafId}"]`)
        if (!titleBar || !pane || !titleDragHandle) {
          return null
        }
        const titleRect = titleBar.getBoundingClientRect()
        const hitElement = document.elementFromPoint(
          titleRect.left + titleRect.width / 2,
          titleRect.top + 4
        )
        return {
          hitDragHandle:
            hitElement instanceof HTMLElement &&
            hitElement.closest('.pane-title-drag-handle') !== null,
          pointerEvents: getComputedStyle(titleDragHandle).pointerEvents,
          titleTop: titleRect.top,
          handleTop: titleDragHandle.getBoundingClientRect().top
        }
      },
      { title, titledLeafId }
    )

    expect(titleTopHit).not.toBeNull()
    expect(titleTopHit?.hitDragHandle).toBe(true)
    expect(titleTopHit?.pointerEvents).toBe('auto')
    expect(Math.abs((titleTopHit?.handleTop ?? 0) - (titleTopHit?.titleTop ?? 0))).toBeLessThan(1)

    await orcaPage.locator('.pane-title-bar', { hasText: title }).click({
      position: { x: 20, y: 18 }
    })
    await expect(orcaPage.locator('.pane-title-input')).toBeVisible()
  })

  test('@headful Set Title pane can be dragged from the title strip', async ({ orcaPage }) => {
    const title = `Dragged title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before drag')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const beforeDrag = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const target = beforeDrag.panes.find((pane) => pane.leafId !== titledLeafId)
    if (!target) {
      throw new Error('No target pane found for titled pane drag')
    }
    const beforeOrder = await readTerminalPaneDomLeafOrder(orcaPage)

    const titleDragHandle = orcaPage
      .locator('.pane-title-bar', { hasText: title })
      .locator('.pane-title-drag-handle')
    await expect(titleDragHandle).toBeVisible({ timeout: 3_000 })
    const sourceBox = await titleDragHandle.boundingBox()
    const targetBox = await orcaPage.locator(`.pane[data-leaf-id="${target.leafId}"]`).boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    const sourceIndex = beforeOrder.indexOf(titledLeafId)
    const targetIndex = beforeOrder.indexOf(target.leafId)
    const targetDropX =
      sourceIndex < targetIndex ? targetBox!.x + targetBox!.width - 8 : targetBox!.x + 8

    await orcaPage.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + 4)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(targetDropX, targetBox!.y + targetBox!.height / 2, {
      steps: 20
    })
    await orcaPage.mouse.up()

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(orcaPage), {
        timeout: 10_000,
        message: 'Title-strip pane drag did not update DOM order'
      })
      .not.toEqual(beforeOrder)
    const afterDrag = await waitForPaneIdentitySnapshot(orcaPage, 2)
    expect(afterDrag.panes.map((pane) => pane.leafId).sort()).toEqual(
      beforeDrag.panes.map((pane) => pane.leafId).sort()
    )
    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)
  })
})
