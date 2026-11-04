import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachResolvedPathsToActiveNativeChatComposer,
  markNativeChatComposerPathAttachFocused,
  registerNativeChatComposerPathAttach,
  resetNativeChatComposerPathAttachForTests
} from './native-chat-composer-path-attach'

afterEach(() => {
  resetNativeChatComposerPathAttachForTests()
})

describe('native chat composer path attach', () => {
  it('attaches to the only ready composer', () => {
    const attachResolvedPaths = vi.fn()
    registerNativeChatComposerPathAttach('pane-a', { attachResolvedPaths, disabled: false })

    expect(attachResolvedPathsToActiveNativeChatComposer(['/repo/a.ts'], 'ssh-1')).toBe(true)
    expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith(['/repo/a.ts'], 'ssh-1')
  })

  it('attaches to the last focused composer when several are mounted', () => {
    const background = vi.fn()
    const focused = vi.fn()
    registerNativeChatComposerPathAttach('pane-a', {
      attachResolvedPaths: background,
      disabled: false
    })
    registerNativeChatComposerPathAttach('pane-b', {
      attachResolvedPaths: focused,
      disabled: false
    })
    markNativeChatComposerPathAttachFocused('pane-b')

    expect(attachResolvedPathsToActiveNativeChatComposer(['/repo/b.ts'])).toBe(true)
    expect(focused).toHaveBeenCalledExactlyOnceWith(['/repo/b.ts'], undefined)
    expect(background).not.toHaveBeenCalled()
  })

  it('keeps last-focused when the focused composer replaces its attacher', () => {
    const background = vi.fn()
    const beforeCaret = vi.fn()
    const afterCaret = vi.fn()
    registerNativeChatComposerPathAttach('pane-a', {
      attachResolvedPaths: background,
      disabled: false
    })
    registerNativeChatComposerPathAttach('pane-b', {
      attachResolvedPaths: beforeCaret,
      disabled: false
    })
    markNativeChatComposerPathAttachFocused('pane-b')
    registerNativeChatComposerPathAttach('pane-b', {
      attachResolvedPaths: afterCaret,
      disabled: false
    })

    expect(attachResolvedPathsToActiveNativeChatComposer(['/repo/b.ts'])).toBe(true)
    expect(afterCaret).toHaveBeenCalledExactlyOnceWith(['/repo/b.ts'], undefined)
    expect(beforeCaret).not.toHaveBeenCalled()
    expect(background).not.toHaveBeenCalled()
  })

  it('skips a disabled composer and does not guess among several ready ones', () => {
    const disabled = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    registerNativeChatComposerPathAttach('pane-disabled', {
      attachResolvedPaths: disabled,
      disabled: true
    })
    registerNativeChatComposerPathAttach('pane-a', { attachResolvedPaths: first, disabled: false })
    registerNativeChatComposerPathAttach('pane-b', { attachResolvedPaths: second, disabled: false })

    expect(attachResolvedPathsToActiveNativeChatComposer(['/repo/c.ts'])).toBe(false)
    expect(disabled).not.toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })
})
