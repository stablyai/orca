// @vitest-environment happy-dom

import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

let storedWidth = 420
const setStoredWidth = vi.fn((width: number) => {
  storedWidth = width
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      combinedDiffFileTreeWidth: storedWidth,
      setCombinedDiffFileTreeWidth: setStoredWidth
    })
}))

const { useCombinedDiffFileTreeResize } = await import('./use-combined-diff-file-tree-resize')

function TreeHarness({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const { treeRef } = useCombinedDiffFileTreeResize(collapsed)
  return (
    <div>
      {collapsed ? null : (
        <aside ref={treeRef as React.RefObject<HTMLElement>} data-testid="tree" />
      )}
    </div>
  )
}

describe('useCombinedDiffFileTreeResize', () => {
  it('reapplies the stored width after the tree collapses and expands', () => {
    const view = render(<TreeHarness collapsed={false} />)
    expect(view.getByTestId('tree').style.width).toBe('420px')

    view.rerender(<TreeHarness collapsed={true} />)
    expect(view.queryByTestId('tree')).toBeNull()

    // Why: the hook outlives the unmounted aside, so a stale layout effect would leave it width-less.
    view.rerender(<TreeHarness collapsed={false} />)
    expect(view.getByTestId('tree').style.width).toBe('420px')
  })
})
