import { describe, expect, it } from 'vitest'
import { matchNativeChatSplitShortcut } from './native-chat-split-shortcut'

describe('matchNativeChatSplitShortcut', () => {
  it('uses the existing platform split bindings', () => {
    expect(
      matchNativeChatSplitShortcut(
        { key: 'd', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        'darwin',
        {}
      )
    ).toBe('right')
    expect(
      matchNativeChatSplitShortcut(
        { key: 'd', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        'win32',
        {}
      )
    ).toBe('right')
    expect(
      matchNativeChatSplitShortcut(
        { key: 'd', metaKey: false, ctrlKey: false, altKey: true, shiftKey: true },
        'linux',
        {}
      )
    ).toBe('down')
  })

  it('respects customized bindings', () => {
    expect(
      matchNativeChatSplitShortcut(
        { key: 'ArrowRight', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false },
        'linux',
        { 'terminal.splitRight': ['Ctrl+Alt+Right'] }
      )
    ).toBe('right')
  })
})
