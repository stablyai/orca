// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { requestTerminalTabRename } from './terminal-tab-rename-request'
import { useSortableTabRename } from './use-sortable-tab-rename'

function renderRename(renamable?: boolean) {
  return renderHook(() =>
    useSortableTabRename({
      tabId: 'home-tab',
      title: 'Home',
      onSetCustomTitle: vi.fn(),
      ...(renamable === undefined ? {} : { renamable })
    })
  )
}

describe('useSortableTabRename', () => {
  it('opens the inline edit from a double-click or the rename shortcut', () => {
    const view = renderRename()

    act(() => view.result.current.handleRenameOpen())

    expect(view.result.current.isEditing).toBe(true)
    expect(view.result.current.renameValue).toBe('Home')
  })

  it("never opens it on a tab whose name is fixed, such as a bot's Home", () => {
    const view = renderRename(false)

    act(() => view.result.current.handleRenameOpen())
    act(() => requestTerminalTabRename('home-tab'))

    expect(view.result.current.isEditing).toBe(false)
  })
})
