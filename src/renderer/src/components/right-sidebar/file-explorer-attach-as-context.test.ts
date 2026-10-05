/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachExplorerFileAsContext } from './file-explorer-attach-as-context'
import {
  registerNativeChatComposerPathAttach,
  resetNativeChatComposerPathAttachForTests
} from '@/components/native-chat/native-chat-composer-path-attach'

afterEach(() => {
  resetNativeChatComposerPathAttachForTests()
  document.body.replaceChildren()
})

describe('attachExplorerFileAsContext', () => {
  it('attaches the resolved path through the active native-chat composer', () => {
    const attachResolvedPaths = vi.fn()
    registerNativeChatComposerPathAttach('pane-a', { attachResolvedPaths, disabled: false })

    expect(attachExplorerFileAsContext('/repo/src/index.ts', 'ssh-1')).toBe(true)
    expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith(['/repo/src/index.ts'], 'ssh-1')
  })

  it('does not mutate a focused textarea when no native-chat composer is registered', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'review  here'
    textarea.selectionStart = 7
    textarea.selectionEnd = 7
    document.body.appendChild(textarea)
    textarea.focus()

    expect(attachExplorerFileAsContext('/repo/My File.ts')).toBe(false)
    expect(textarea.value).toBe('review  here')
  })

  it('does not insert into a focused input that is not a composer textarea', () => {
    const input = document.createElement('input')
    input.value = 'src'
    document.body.appendChild(input)
    input.focus()

    expect(attachExplorerFileAsContext('/repo/src/index.ts')).toBe(false)
    expect(input.value).toBe('src')
  })
})
