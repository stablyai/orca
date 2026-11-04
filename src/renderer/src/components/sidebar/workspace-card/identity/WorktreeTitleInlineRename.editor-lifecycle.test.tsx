// @vitest-environment happy-dom

import { useState } from 'react'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

afterEach(() => {
  cleanup()
  // Unmount cleanup does not restore prototype spies.
  vi.restoreAllMocks()
})

const DISPLAY_NAME = 'Feature workspace'

function renameEditor(): HTMLInputElement | null {
  return screen.queryByRole<HTMLInputElement>('textbox', { name: 'Rename workspace' })
}

type HarnessProps = {
  displayName?: string
  onRename?: (displayName: string) => Promise<void> | void
  onEditingChange?: (editing: boolean) => void
  showUnreadEmphasis?: boolean
}

// Mirror the card clearing its shortcut trigger; the editor must retain open state itself.
function ShortcutRenameHarness({
  displayName = DISPLAY_NAME,
  onRename = vi.fn(),
  onEditingChange,
  showUnreadEmphasis = false
}: HarnessProps): React.JSX.Element {
  const [renameRequested, setRenameRequested] = useState(true)
  return (
    <WorktreeTitleInlineRename
      displayName={displayName}
      showUnreadEmphasis={showUnreadEmphasis}
      onRename={onRename}
      onEditingChange={onEditingChange}
      beginEditing={renameRequested}
      onBeginEditingConsumed={() => setRenameRequested(false)}
    />
  )
}

function openEditorByShortcut(props: HarnessProps = {}): {
  input: HTMLInputElement
  markUnread: () => void
  renameElsewhere: (displayName: string) => void
} {
  const { rerender } = render(<ShortcutRenameHarness {...props} />)
  const input = renameEditor()
  if (!input) {
    throw new Error('the rename shortcut did not open an editor')
  }
  return {
    input,
    markUnread: () => rerender(<ShortcutRenameHarness {...props} showUnreadEmphasis={true} />),
    renameElsewhere: (displayName) =>
      rerender(<ShortcutRenameHarness {...props} displayName={displayName} />)
  }
}

describe('WorktreeTitleInlineRename editor lifecycle', () => {
  it('leaves an open editor untouched when the workspace is renamed elsewhere', () => {
    const { input, renameElsewhere } = openEditorByShortcut()
    fireEvent.change(input, { target: { value: 'Half typed name' } })
    const selectAfterOpen = vi.spyOn(HTMLInputElement.prototype, 'select')

    renameElsewhere('Renamed by an agent')

    expect(renameEditor()).toBe(input)
    expect(input.value).toBe('Half typed name')
    expect(document.activeElement).toBe(input)
    expect(selectAfterOpen).not.toHaveBeenCalled()
  })

  it('leaves an open editor untouched when an unread notification arrives', () => {
    const { input, markUnread } = openEditorByShortcut()
    fireEvent.change(input, { target: { value: 'Half typed name' } })
    const selectAfterOpen = vi.spyOn(HTMLInputElement.prototype, 'select')

    markUnread()

    // Remounting reselects the name and loses typing; verify input identity, draft and focus.
    expect(renameEditor()).toBe(input)
    expect(input.value).toBe('Half typed name')
    expect(document.activeElement).toBe(input)
    expect(selectAfterOpen).not.toHaveBeenCalled()
  })
})
