import { describe, expect, it } from 'vitest'
import { nativeChatPromptClaimsShortcut } from './text-input-shortcut-policy'

describe('chat prompt and workspace cycling', () => {
  it('yields the default workspace chords like the terminal does', () => {
    const up = { key: 'ArrowUp', metaKey: true, shiftKey: true }
    const down = { key: 'ArrowDown', ctrlKey: true, shiftKey: true }
    expect(nativeChatPromptClaimsShortcut(up, 'darwin', 'worktree.navigateUp', true)).toBe(false)
    expect(nativeChatPromptClaimsShortcut(down, 'win32', 'worktree.navigateDown', true)).toBe(false)
  })

  it('keeps select-to-start/end when the editor is not a chat pane composer', () => {
    const up = { key: 'ArrowUp', metaKey: true, shiftKey: true }
    expect(nativeChatPromptClaimsShortcut(up, 'darwin', 'worktree.navigateUp', false)).toBe(true)
  })
})
