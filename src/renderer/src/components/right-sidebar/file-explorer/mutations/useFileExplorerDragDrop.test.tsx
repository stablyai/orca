// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'

function renderDragDrop() {
  return renderHook(() =>
    useFileExplorerDragDrop({
      worktreePath: '/repo',
      activeWorktreeId: 'wt-1',
      expanded: new Set<string>(),
      toggleDir: () => {},
      refreshDir: async () => {},
      scrollRef: { current: null },
      getOperationOwnerForPath: () => undefined
    })
  )
}

describe('useFileExplorerDragDrop', () => {
  afterEach(cleanup)

  // An external DownloadURL drop can end the drag without dragend reaching the page.
  it.each([
    ['pointerdown', () => document.dispatchEvent(new Event('pointerdown'))],
    ['focus', () => window.dispatchEvent(new Event('focus'))]
  ])('clears a drag source whose dragend never arrived on %s', (_name, dispatch) => {
    const { result } = renderDragDrop()
    act(() => result.current.setDragSourcePath('/repo/a.txt'))
    expect(result.current.dragSourcePath).toBe('/repo/a.txt')

    act(dispatch)

    expect(result.current.dragSourcePath).toBeNull()
  })
})
