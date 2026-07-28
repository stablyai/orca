// @vitest-environment happy-dom

import { StrictMode } from 'react'
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

  it('notifies the parent once per editing transition', () => {
    const onEditingChange = vi.fn()
    const props = {
      displayName: 'old name',
      showUnreadEmphasis: false,
      onEditingChange,
      onRename: vi.fn()
    }

    const { container, rerender } = render(<WorktreeTitleInlineRename {...props} />)
    fireEvent.doubleClick(container.querySelector('[data-worktree-title-inline-rename=""]')!)

    expect(onEditingChange).toHaveBeenCalledTimes(1)
    expect(onEditingChange).toHaveBeenLastCalledWith(true)

    rerender(<WorktreeTitleInlineRename {...props} />)
    rerender(<WorktreeTitleInlineRename {...props} showUnreadEmphasis={true} />)

    // Why: the hovercard defers its close on a `false`, so a repeat notification must not re-fire.
    expect(onEditingChange).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(getRenameInput(container)!, { key: 'Escape' })

    expect(onEditingChange).toHaveBeenCalledTimes(2)
    expect(onEditingChange).toHaveBeenLastCalledWith(false)

    rerender(<WorktreeTitleInlineRename {...props} showUnreadEmphasis={true} />)

    expect(onEditingChange).toHaveBeenCalledTimes(2)
  })

  it('notifies the parent once even when StrictMode replays the open effect', () => {
    const onEditingChange = vi.fn()

    render(
      <StrictMode>
        <WorktreeTitleInlineRename
          displayName="old name"
          beginEditing={true}
          onBeginEditingConsumed={vi.fn()}
          onEditingChange={onEditingChange}
          onRename={vi.fn()}
        />
      </StrictMode>
    )

    // Why: the app mounts under StrictMode, so the open effect runs twice off one
    // render — both passes see the pre-open state and would each notify the parent.
    expect(onEditingChange).toHaveBeenCalledTimes(1)
    expect(onEditingChange).toHaveBeenLastCalledWith(true)
  })

  it('notifies the parent once when the shortcut opens the editor', async () => {
    const onEditingChange = vi.fn()
    const onBeginEditingConsumed = vi.fn()
    const props = {
      displayName: 'old name',
      onEditingChange,
      onBeginEditingConsumed,
      onRename: vi.fn().mockResolvedValue(undefined)
    }

    const { container, rerender } = render(
      <WorktreeTitleInlineRename {...props} beginEditing={true} />
    )
    rerender(<WorktreeTitleInlineRename {...props} beginEditing={false} />)
    rerender(<WorktreeTitleInlineRename {...props} beginEditing={false} />)

    expect(onEditingChange).toHaveBeenCalledTimes(1)
    expect(onEditingChange).toHaveBeenLastCalledWith(true)

    const input = getRenameInput(container)
    fireEvent.change(input!, { target: { value: 'new name' } })
    fireEvent.keyDown(input!, { key: 'Enter' })
    await waitFor(() => expect(onEditingChange).toHaveBeenCalledTimes(2))

    expect(onEditingChange).toHaveBeenLastCalledWith(false)
  })
})
