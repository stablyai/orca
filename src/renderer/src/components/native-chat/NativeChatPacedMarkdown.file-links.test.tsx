// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileLinkExists } from '../../../../shared/native-chat/native-chat-file-link-tree'
import { NativeChatPacedMarkdown } from './NativeChatPacedMarkdown'
import { NativeChatFileLinkExistenceContext } from './native-chat-file-link-existence'
import type { NativeChatFileLinkExistence } from '../../../../shared/native-chat/native-chat-file-link-existence'
import {
  NativeChatReplyRevealsContext,
  type NativeChatReplyReveals
} from './native-chat-reply-reveals'
import { NATIVE_CHAT_TEXT_REVEAL_DELAY_MS } from '../../../../shared/native-chat/transcript/native-chat-text-reveal'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'

vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))

const reveals: NativeChatReplyReveals = { begun: new Set(['reply']), drawn: new Map() }
const check = vi.fn<FileLinkExists>(() => true)
const peek = vi.fn<FileLinkExists>(() => false)
const snapshot = { check, peek }
const existence: NativeChatFileLinkExistence = {
  watch: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }),
  recheck: () => {}
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  reveals.drawn.clear()
  check.mockClear()
  peek.mockClear()
})

it('asks the host about paths only once a paced reply has been fully revealed', () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance'
    ]
  })
  const onLinkClick = vi.fn()
  const reply = (streaming: boolean) => (
    <NativeChatFileLinkExistenceContext.Provider value={existence}>
      <NativeChatReplyRevealsContext.Provider value={reveals}>
        <NativeChatLinkClickContext value={onLinkClick}>
          <NativeChatPacedMarkdown
            rowKey="reply"
            content="Edited src/app.ts for you."
            streaming={streaming}
            variant="document"
            linkifyFilePaths
          />
        </NativeChatLinkClickContext>
      </NativeChatReplyRevealsContext.Provider>
    </NativeChatFileLinkExistenceContext.Provider>
  )
  const view = render(reply(true))
  act(() => vi.advanceTimersByTime(100))
  // Why: the stream has ended but the text is still being drawn, so it counts as arriving.
  view.rerender(reply(false))
  expect(check).not.toHaveBeenCalled()

  act(() => vi.advanceTimersByTime(NATIVE_CHAT_TEXT_REVEAL_DELAY_MS))

  expect(check).toHaveBeenCalledWith(expect.objectContaining({ pathText: 'src/app.ts' }))
  expect(view.container.querySelector('a')?.textContent).toBe('src/app.ts')
})
