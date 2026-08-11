// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover', () => ({
  WorkspaceEmojiSuggestionPopover: () => null
}))

vi.mock('@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput', () => ({
  useWorkspaceEmojiShortcodeInput: ({
    onValueChange
  }: {
    onValueChange: (value: string) => void
  }) => ({
    close: vi.fn(),
    commandValue: '',
    handleKeyDown: () => false,
    handleValueChange: (value: string) => onValueChange(value),
    onCommandValueChange: vi.fn(),
    open: false,
    selectSuggestion: vi.fn(),
    suggestions: [],
    syncCursor: vi.fn()
  })
}))

afterEach(cleanup)

// Why: mirrors WorktreeCard — the shortcut raises the trigger and the card clears it
// as soon as the title consumes it, so the editor stays open on its own state.
function ShortcutRenameHarness({
  onRename,
  showUnreadEmphasis = false
}: {
  onRename: (displayName: string) => Promise<void> | void
  showUnreadEmphasis?: boolean
}): React.JSX.Element {
  const [renameRequested, setRenameRequested] = useState(true)
  return (
    <WorktreeTitleInlineRename
      displayName="Feature workspace"
      showUnreadEmphasis={showUnreadEmphasis}
      onRename={onRename}
      beginEditing={renameRequested}
      onBeginEditingConsumed={() => setRenameRequested(false)}
    />
  )
}

function openEditorByShortcut(onRename: (displayName: string) => Promise<void> | void = vi.fn()): {
  container: HTMLElement
  input: HTMLInputElement
  markUnread: () => void
} {
  const { container, rerender } = render(<ShortcutRenameHarness onRename={onRename} />)
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('the rename shortcut did not open an editor')
  }
  return {
    container,
    input,
    markUnread: () =>
      rerender(<ShortcutRenameHarness onRename={onRename} showUnreadEmphasis={true} />)
  }
}

describe('WorktreeTitleInlineRename editor lifecycle', () => {
  it('closes the shortcut-opened editor on Escape', () => {
    const { container, input } = openEditorByShortcut()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(container.querySelector('input')).toBeNull()
  })

  it('closes the shortcut-opened editor once the rename commits', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const { container, input } = openEditorByShortcut(onRename)

    fireEvent.change(input, { target: { value: 'Renamed workspace' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(container.querySelector('input')).toBeNull())
    expect(onRename).toHaveBeenCalledWith('Renamed workspace')
  })

  it('closes the shortcut-opened editor when it loses focus', async () => {
    const { container, input } = openEditorByShortcut()

    fireEvent.blur(input)

    await waitFor(() => expect(container.querySelector('input')).toBeNull())
  })

  it('leaves an open editor untouched when an unread notification arrives', () => {
    const { container, input, markUnread } = openEditorByShortcut()
    fireEvent.change(input, { target: { value: 'Half typed name' } })
    const selectAfterOpen = vi.spyOn(HTMLInputElement.prototype, 'select')

    markUnread()

    // Remounting the input would re-run focus + select, so the next keystroke
    // would replace the half-typed name instead of appending to it.
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe('Half typed name')
    expect(selectAfterOpen).not.toHaveBeenCalled()
  })
})
