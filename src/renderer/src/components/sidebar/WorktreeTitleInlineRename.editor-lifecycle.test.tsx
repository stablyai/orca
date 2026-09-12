// @vitest-environment happy-dom

import { StrictMode, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  // cleanup only unmounts, so a prototype spy would outlive its test
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

// Mirrors WorktreeCard: the card clears the trigger as soon as the title consumes it,
// so from then on the editor stays open on its own state.
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
  it('closes the shortcut-opened editor on Escape', () => {
    const { input } = openEditorByShortcut()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameEditor()).toBeNull()
  })

  it('closes the shortcut-opened editor once the rename commits', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const { input } = openEditorByShortcut({ onRename })

    fireEvent.change(input, { target: { value: 'Renamed workspace' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameEditor()).toBeNull())
    expect(onRename).toHaveBeenCalledWith('Renamed workspace')
  })

  it('closes the shortcut-opened editor when it loses focus', async () => {
    const { input } = openEditorByShortcut()

    fireEvent.blur(input)

    await waitFor(() => expect(renameEditor()).toBeNull())
  })

  // The parent re-enables drag off this callback, so a close that skips it leaves the
  // card wedged even though the editor disappeared.
  it('reports both edit-mode transitions to the parent exactly once', () => {
    const onEditingChange = vi.fn()
    const { input } = openEditorByShortcut({ onEditingChange })

    expect(onEditingChange.mock.calls).toEqual([[true]])

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onEditingChange.mock.calls).toEqual([[true], [false]])
  })

  it('reports the shortcut-open transition once in Strict Mode', () => {
    const onEditingChange = vi.fn()

    render(
      <StrictMode>
        <ShortcutRenameHarness onEditingChange={onEditingChange} />
      </StrictMode>
    )

    expect(onEditingChange.mock.calls).toEqual([[true]])
  })

  it('opens the editor on double-click and reports it the same way', () => {
    const onEditingChange = vi.fn()
    render(
      <WorktreeTitleInlineRename
        displayName={DISPLAY_NAME}
        onRename={vi.fn()}
        onEditingChange={onEditingChange}
      />
    )
    expect(renameEditor()).toBeNull()

    fireEvent.doubleClick(screen.getByText(DISPLAY_NAME))

    expect(renameEditor()).not.toBeNull()
    expect(onEditingChange.mock.calls).toEqual([[true]])
  })

  it('focuses and selects the current name when the editor opens', () => {
    const select = vi.spyOn(HTMLInputElement.prototype, 'select')

    const { input } = openEditorByShortcut()

    expect(document.activeElement).toBe(input)
    expect(select).toHaveBeenCalledTimes(1)
  })

  // The hovercard editor never sets the unread flag, so a title change is the only
  // way its key used to move.
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

    // A remount re-runs focus + select and the next keystroke replaces the name; the
    // value and focus assertions catch the same loss arriving without one.
    expect(renameEditor()).toBe(input)
    expect(input.value).toBe('Half typed name')
    expect(document.activeElement).toBe(input)
    expect(selectAfterOpen).not.toHaveBeenCalled()
  })
})
