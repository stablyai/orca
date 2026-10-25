import { expect, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { LEAF_1, LEAF_2, type MockPaneManager } from './pty-connection-test-pane-fixtures'

/** Main-owned exits wait for its leaf-removal frame without sending another close; dynamic imports share the test’s reset module graph. */
export async function expectMainFrameClosesExitedSplitPaneOnce(
  manager: MockPaneManager
): Promise<void> {
  const { layoutApplyTestTransport } =
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  const { reconcileMountedPanesToLayout } = await import('./terminal-pane-frame-reconciliation')
  await layoutApplyTestTransport.settle()
  expect(manager.closePane).not.toHaveBeenCalled()
  expect(layoutApplyTestTransport.sentOfType('closePane')).toEqual([])

  const frameLayout: TerminalLayoutSnapshot = {
    root: { type: 'leaf', leafId: LEAF_1 },
    activeLeafId: LEAF_1,
    expandedLeafId: null
  }
  const closePane = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock manager implements every PaneManager member the frame reconciler reads.
  const framedManager = { ...manager, applyLayoutGeometry: vi.fn() } as unknown as Parameters<
    typeof reconcileMountedPanesToLayout
  >[0]['manager']
  // A repeated frame (the stream re-sends main's tab) must not close it again.
  for (let frame = 0; frame < 2; frame += 1) {
    reconcileMountedPanesToLayout({
      tabId: 'tab-1',
      manager: framedManager,
      layout: frameLayout,
      closePane,
      isExpanded: false
    })
  }
  expect(closePane).toHaveBeenCalledTimes(1)
  expect(closePane).toHaveBeenCalledWith(2, LEAF_2, 'exit')
}
