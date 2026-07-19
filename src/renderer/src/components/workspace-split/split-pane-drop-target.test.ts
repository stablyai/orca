import { describe, it, expect } from 'vitest'
import { resolveSplitPaneDropZone } from './split-pane-drop-target'

const PANES = [
  { worktreeId: 'left-pane', rect: { left: 0, top: 0, width: 400, height: 400 } },
  { worktreeId: 'right-pane', rect: { left: 400, top: 0, width: 400, height: 400 } }
]

describe('resolveSplitPaneDropZone', () => {
  it('returns null outside every pane', () => {
    expect(resolveSplitPaneDropZone({ x: 900, y: 200 }, PANES)).toBeNull()
  })

  it('maps the outer quarters to edge splits of the pane under the pointer', () => {
    expect(resolveSplitPaneDropZone({ x: 40, y: 200 }, PANES)).toMatchObject({
      targetWorktreeId: 'left-pane',
      edge: 'left',
      highlightRect: { left: 0, top: 0, width: 200, height: 400 }
    })
    expect(resolveSplitPaneDropZone({ x: 390, y: 200 }, PANES)).toMatchObject({
      targetWorktreeId: 'left-pane',
      edge: 'right'
    })
    expect(resolveSplitPaneDropZone({ x: 600, y: 30 }, PANES)).toMatchObject({
      targetWorktreeId: 'right-pane',
      edge: 'up',
      highlightRect: { left: 400, top: 0, width: 400, height: 200 }
    })
    expect(resolveSplitPaneDropZone({ x: 600, y: 380 }, PANES)).toMatchObject({
      targetWorktreeId: 'right-pane',
      edge: 'down'
    })
  })

  it('maps the pane middle to replace with a full-pane highlight', () => {
    expect(resolveSplitPaneDropZone({ x: 200, y: 200 }, PANES)).toMatchObject({
      targetWorktreeId: 'left-pane',
      edge: 'replace',
      highlightRect: { left: 0, top: 0, width: 400, height: 400 }
    })
  })

  it('picks the nearest edge when the pointer sits in a corner band', () => {
    // 30px from the left, 60px from the top — left wins.
    expect(resolveSplitPaneDropZone({ x: 30, y: 60 }, PANES)).toMatchObject({ edge: 'left' })
  })

  it('skips zero-size (hidden) panes', () => {
    const panes = [{ worktreeId: 'hidden', rect: { left: 0, top: 0, width: 0, height: 0 } }]
    expect(resolveSplitPaneDropZone({ x: 0, y: 0 }, panes)).toBeNull()
  })
})
