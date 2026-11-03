/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveTabDragLeafTarget } from './tab-drag-leaf-target'
import {
  geometrySnapshot,
  leafRectsFor,
  leafTargetState,
  sourceDrag,
  WT
} from './tab-drag-leaf-target-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// An eligibility that says yes, so only the resolver's own switch check can keep the target null.
vi.mock('../terminal-pane/terminal-tab-into-pane-eligibility', () => ({
  isSourceWideRefusal: () => false,
  resolveTerminalTabIntoPaneEligibility: () => ({ ok: true })
}))

describe('resolveTabDragLeafTarget in a layout-owner build', () => {
  it('finds no leaf target over a pane edge, even where a join would be allowed', () => {
    const target = resolveTabDragLeafTarget({
      activeDrag: sourceDrag(),
      pointer: { x: 790, y: 316 },
      worktreeId: WT,
      state: leafTargetState(),
      geometry: geometrySnapshot(),
      readLeafRects: () => leafRectsFor('split')
    })

    expect(target).toBeNull()
  })
})
