// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown): unknown =>
    selector({
      setTabGroupSplitRatio: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })
}))
vi.mock('./tab-group-layout-owner-commands', () => ({
  setGroupRatioThroughLayoutOwner: vi.fn()
}))
vi.mock('./TabGroupPanel', () => ({
  default: (props: {
    groupId: string
    reserveClosedExplorerToggleSpace: boolean
    reserveCollapsedSidebarHeaderSpace: boolean
  }) => (
    <div
      data-testid={`strip-${props.groupId}`}
      data-reserve-toggle={props.reserveClosedExplorerToggleSpace ? 'true' : 'false'}
      data-reserve-left={props.reserveCollapsedSidebarHeaderSpace ? 'true' : 'false'}
    />
  )
}))

import { TabGroupSplitNodeTree } from './TabGroupSplitNodeTree'
import { buildSplitNode } from '../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import type { TabGroupLayoutNode } from '../../../../shared/workspace-layout/tab-groups/tab-types'

afterEach(cleanup)

function tree(
  layout: TabGroupLayoutNode,
  _chatGroupIds: ReadonlySet<string>,
  _collapse = true
): React.JSX.Element {
  return (
    <TabGroupSplitNodeTree
      layout={layout}
      worktreeId="wt-a"
      isWorktreeActive
      isTabDragActive={false}
      hoveredTabInsertion={null}
    />
  )
}

function reserve(view: ReturnType<typeof render>, groupId: string): string | null {
  return view.getByTestId(`strip-${groupId}`).getAttribute('data-reserve-toggle')
}

function reserveLeft(view: ReturnType<typeof render>, groupId: string): string | null {
  return view.getByTestId(`strip-${groupId}`).getAttribute('data-reserve-left')
}

describe('TabGroupSplitNodeTree folded corner reserve', () => {
  it('keeps the window-controls reserve on the first pane when the second folds to zero', () => {
    // Why: the folded sibling eases to zero flex, so the first owns the window
    // corner — without the spacer its quick-commands/pane-actions buttons slide
    // under the transparent window-controls overlay and ghost together with it.
    const layout = buildSplitNode('chat', 'terminal', 'horizontal', 'second')
    const view = render(tree(layout, new Set(['chat'])))
    expect(reserve(view, 'chat')).toBe('true')
    // Why: the folded second is invisible at zero flex, so its own reserve is moot.
  })

  it('moves the left-edge reserve to the second pane when the first folds to zero', () => {
    const layout = buildSplitNode('terminal', 'chat', 'horizontal', 'second')
    const view = render(tree(layout, new Set(['chat'])))
    expect(reserveLeft(view, 'chat')).toBe('true')
    // Why: the folded first is invisible at zero flex, so its own reserve is moot.
  })

  it('keeps the top-corner reserve on the bottom pane when the top folds to zero', () => {
    const layout = buildSplitNode('terminal', 'chat', 'vertical', 'second')
    const view = render(tree(layout, new Set(['chat'])))
    expect(reserve(view, 'chat')).toBe('true')
  })

  it('reserves nothing extra when no pane folds', () => {
    const layout = buildSplitNode('chat', 'terminal', 'horizontal', 'second')
    const view = render(tree(layout, new Set(['chat']), false))
    expect(reserve(view, 'chat')).toBe('false')
    expect(reserveLeft(view, 'terminal')).toBe('false')
  })
})
