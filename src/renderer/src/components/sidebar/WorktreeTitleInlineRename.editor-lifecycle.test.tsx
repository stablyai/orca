// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'

afterEach(cleanup)

function getRenameInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[data-worktree-title-rename-input="true"]')
}

describe('WorktreeTitleInlineRename editor lifecycle', () => {
  it('closes the editor after the shortcut-opened rename commits', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const onEditingChange = vi.fn()
    const onBeginEditingConsumed = vi.fn()

    const { container, rerender } = render(
      <WorktreeTitleInlineRename
        displayName="old name"
        beginEditing={true}
        onBeginEditingConsumed={onBeginEditingConsumed}
        onEditingChange={onEditingChange}
        onRename={onRename}
      />
    )
    // the parent clears its trigger once the request is consumed
    rerender(
      <WorktreeTitleInlineRename
        displayName="old name"
        beginEditing={false}
        onBeginEditingConsumed={onBeginEditingConsumed}
        onEditingChange={onEditingChange}
        onRename={onRename}
      />
    )

    const input = getRenameInput(container)
    expect(input).not.toBeNull()
    // Why: the card disables drag while renaming, so the shortcut path must report it too.
    expect(onEditingChange).toHaveBeenCalledWith(true)

    fireEvent.change(input!, { target: { value: 'new name' } })
    fireEvent.keyDown(input!, { key: 'Enter' })
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('new name'))

    rerender(
      <WorktreeTitleInlineRename
        displayName="new name"
        beginEditing={false}
        onBeginEditingConsumed={onBeginEditingConsumed}
        onEditingChange={onEditingChange}
        onRename={onRename}
      />
    )

    expect(getRenameInput(container)).toBeNull()
    expect(onEditingChange).toHaveBeenLastCalledWith(false)
  })

  it('closes the editor when the shortcut-opened rename is cancelled with Escape', () => {
    const onBeginEditingConsumed = vi.fn()

    const { container, rerender } = render(
      <WorktreeTitleInlineRename
        displayName="old name"
        beginEditing={true}
        onBeginEditingConsumed={onBeginEditingConsumed}
        onRename={vi.fn()}
      />
    )
    rerender(
      <WorktreeTitleInlineRename
        displayName="old name"
        beginEditing={false}
        onBeginEditingConsumed={onBeginEditingConsumed}
        onRename={vi.fn()}
      />
    )

    const input = getRenameInput(container)
    expect(input).not.toBeNull()
    fireEvent.keyDown(input!, { key: 'Escape' })

    rerender(
      <WorktreeTitleInlineRename
        displayName="old name"
        beginEditing={false}
        onBeginEditingConsumed={onBeginEditingConsumed}
        onRename={vi.fn()}
      />
    )

    expect(getRenameInput(container)).toBeNull()
  })

  it('closes the editor after a double-click rename commits', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)

    const { container, rerender } = render(
      <WorktreeTitleInlineRename displayName="old name" onRename={onRename} />
    )

    fireEvent.doubleClick(container.querySelector('[data-worktree-title-inline-rename=""]')!)
    const input = getRenameInput(container)
    expect(input).not.toBeNull()

    fireEvent.change(input!, { target: { value: 'new name' } })
    fireEvent.keyDown(input!, { key: 'Enter' })
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('new name'))

    rerender(<WorktreeTitleInlineRename displayName="new name" onRename={onRename} />)

    expect(getRenameInput(container)).toBeNull()
  })

  it('keeps the open editor untouched when the row flips to unread', () => {
    const { container, rerender } = render(
      <WorktreeTitleInlineRename
        displayName="old name"
        showUnreadEmphasis={false}
        onRename={vi.fn()}
      />
    )

    fireEvent.doubleClick(container.querySelector('[data-worktree-title-inline-rename=""]')!)
    const input = getRenameInput(container)
    expect(input).not.toBeNull()
    // the user is mid-edit with the caret placed inside the title
    input!.setSelectionRange(3, 3)

    // an agent-completion notification marks this workspace unread mid-edit
    rerender(
      <WorktreeTitleInlineRename
        displayName="old name"
        showUnreadEmphasis={true}
        onRename={vi.fn()}
      />
    )

    // Why: remounting the editor would reselect the whole title, so the next keystroke replaces it.
    expect(getRenameInput(container)).toBe(input)
    expect(input!.selectionStart).toBe(3)
    expect(input!.selectionEnd).toBe(3)
  })
})
