/**
 * E2E tests for leaf-keyed PTY bindings surviving pane close, remake, and move.
 *
 * User Prompt:
 * - closing panes works
 */

import { test, expect } from './helpers/mcode-app'
import {
  closeActiveTerminalPane,
  moveTerminalPaneByLeafId,
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForPaneIdentitySnapshot,
  waitForPaneCount
} from './helpers/terminal'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

// Why: keep the suite serial so the headful pane tests never ask Playwright to
// open multiple visible Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('closing a split pane prunes its leaf-keyed PTY binding without remapping siblings', async ({
    mcodePage
  }) => {
    await splitActiveTerminalPane(mcodePage, 'vertical')
    await waitForPaneCount(mcodePage, 2)
    await splitActiveTerminalPane(mcodePage, 'horizontal')
    await waitForPaneCount(mcodePage, 3)

    const beforeClose = await waitForPaneIdentitySnapshot(mcodePage, 3)
    const closedLeafId = beforeClose.activeLeafId ?? beforeClose.panes.at(-1)?.leafId
    if (!closedLeafId) {
      throw new Error('No active split pane leaf id found before close')
    }
    const survivingLeafIds = beforeClose.panes
      .map((pane) => pane.leafId)
      .filter((leafId) => leafId !== closedLeafId)

    await closeActiveTerminalPane(mcodePage)
    await waitForPaneCount(mcodePage, 2)

    const afterClose = await waitForPaneIdentitySnapshot(mcodePage, 2)
    expect(afterClose.panes.map((pane) => pane.leafId).sort()).toEqual(survivingLeafIds.sort())
    expect(Object.keys(afterClose.ptyIdsByLeafId).sort()).toEqual(survivingLeafIds.sort())
    expect(afterClose.ptyIdsByLeafId[closedLeafId]).toBeUndefined()
  })

  test('closing and remaking right/down splits keeps surviving leaf-keyed bindings stable', async ({
    mcodePage
  }) => {
    await splitActiveTerminalPane(mcodePage, 'vertical')
    await waitForPaneCount(mcodePage, 2)
    await splitActiveTerminalPane(mcodePage, 'horizontal')
    await waitForPaneCount(mcodePage, 3)

    const beforeClose = await waitForPaneIdentitySnapshot(mcodePage, 3)
    const closedLeafId = beforeClose.activeLeafId ?? beforeClose.panes.at(-1)?.leafId
    if (!closedLeafId) {
      throw new Error('No active split pane leaf id found before close/remake')
    }
    const survivingBindings = Object.fromEntries(
      beforeClose.panes
        .filter((pane) => pane.leafId !== closedLeafId)
        .map((pane) => [pane.leafId, pane.ptyId])
    )

    await closeActiveTerminalPane(mcodePage)
    await waitForPaneCount(mcodePage, 2)

    const afterClose = await waitForPaneIdentitySnapshot(mcodePage, 2)
    expect(Object.keys(afterClose.ptyIdsByLeafId).sort()).toEqual(
      Object.keys(survivingBindings).sort()
    )
    for (const [leafId, ptyId] of Object.entries(survivingBindings)) {
      expect(afterClose.ptyIdsByLeafId[leafId]).toBe(ptyId)
    }
    expect(afterClose.ptyIdsByLeafId[closedLeafId]).toBeUndefined()

    await splitActiveTerminalPane(mcodePage, 'horizontal')
    await waitForPaneCount(mcodePage, 3)

    const afterRemake = await waitForPaneIdentitySnapshot(mcodePage, 3)
    const remadeLeafIds = afterRemake.panes.map((pane) => pane.leafId)
    expect(remadeLeafIds).not.toContain(closedLeafId)
    for (const [leafId, ptyId] of Object.entries(survivingBindings)) {
      expect(afterRemake.ptyIdsByLeafId[leafId]).toBe(ptyId)
    }
    expect(new Set(remadeLeafIds).size).toBe(3)
  })

  test('moving panes through the drag-drop handler preserves leaf-keyed PTY bindings', async ({
    mcodePage
  }) => {
    await splitActiveTerminalPane(mcodePage, 'vertical')
    await waitForPaneCount(mcodePage, 2)
    await splitActiveTerminalPane(mcodePage, 'horizontal')
    await waitForPaneCount(mcodePage, 3)

    const beforeMove = await waitForPaneIdentitySnapshot(mcodePage, 3)
    const beforeOrder = await readTerminalPaneDomLeafOrder(mcodePage)
    const source = beforeMove.panes.at(-1)
    const target = beforeMove.panes[0]
    if (!source || !target) {
      throw new Error('Need source and target panes for move test')
    }
    const bindingsBefore = { ...beforeMove.ptyIdsByLeafId }

    await moveTerminalPaneByLeafId(mcodePage, source.leafId, target.leafId, 'left')

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(mcodePage), {
        timeout: 10_000,
        message: 'Pane drag-drop move did not update DOM order'
      })
      .not.toEqual(beforeOrder)

    const afterMove = await waitForPaneIdentitySnapshot(mcodePage, 3)
    const afterLeafIds = afterMove.panes.map((pane) => pane.leafId).sort()
    expect(afterLeafIds).toEqual(beforeMove.panes.map((pane) => pane.leafId).sort())
    expect(afterMove.ptyIdsByLeafId).toEqual(bindingsBefore)
  })

  test('@headful dragging terminal panes around preserves leaf-keyed PTY bindings', async ({
    mcodePage
  }) => {
    await splitActiveTerminalPane(mcodePage, 'vertical')
    await waitForPaneCount(mcodePage, 2)
    await splitActiveTerminalPane(mcodePage, 'horizontal')
    await waitForPaneCount(mcodePage, 3)

    const beforeDrag = await waitForPaneIdentitySnapshot(mcodePage, 3)
    const beforeOrder = await readTerminalPaneDomLeafOrder(mcodePage)
    const source = beforeDrag.panes.at(-1)
    const target = beforeDrag.panes[0]
    if (!source || !target) {
      throw new Error('Need source and target panes for drag test')
    }

    const sourceHandle = mcodePage.locator(
      `.pane[data-leaf-id="${source.leafId}"] .pane-drag-handle`
    )
    await expect(sourceHandle).toBeVisible({ timeout: 3_000 })
    const sourceBox = await sourceHandle.boundingBox()
    const targetBox = await mcodePage.locator(`.pane[data-leaf-id="${target.leafId}"]`).boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()

    await mcodePage.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + 4)
    await mcodePage.mouse.down()
    await mcodePage.mouse.move(targetBox!.x + 8, targetBox!.y + targetBox!.height / 2, {
      steps: 20
    })
    await mcodePage.mouse.up()

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(mcodePage), {
        timeout: 10_000,
        message: 'Real pane drag did not update DOM order'
      })
      .not.toEqual(beforeOrder)

    const afterDrag = await waitForPaneIdentitySnapshot(mcodePage, 3)
    expect(afterDrag.panes.map((pane) => pane.leafId).sort()).toEqual(
      beforeDrag.panes.map((pane) => pane.leafId).sort()
    )
    expect(afterDrag.ptyIdsByLeafId).toEqual(beforeDrag.ptyIdsByLeafId)
  })
})
