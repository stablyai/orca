// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { requestTerminalTabRename } from './terminal-tab-rename-request'
import { useSortableTabRename } from './use-sortable-tab-rename'

describe('useSortableTabRename', () => {
  it("never opens it on a tab whose name is fixed, such as a bot's Home", () => {
    const view = renderHook(() =>
      useSortableTabRename({
        tabId: 'home-tab',
        title: 'Home',
        onSetCustomTitle: vi.fn(),
        renamable: false
      })
    )

    act(() => view.result.current.handleRenameOpen())
    act(() => requestTerminalTabRename('home-tab'))

    expect(view.result.current.isEditing).toBe(false)
  })
})
