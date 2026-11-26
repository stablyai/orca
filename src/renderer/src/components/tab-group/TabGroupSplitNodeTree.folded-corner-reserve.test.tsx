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

function tree(layout: TabGroupLayoutNode): React.JSX.Element {
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

describe('TabGroupSplitNodeTree corner reserve', () => {
  it('reserves nothing extra when no pane folds', () => {
    const layout = buildSplitNode('chat', 'terminal', 'horizontal', 'second')
    const view = render(tree(layout))
    expect(reserve(view, 'chat')).toBe('false')
    expect(reserveLeft(view, 'terminal')).toBe('false')
  })
})
