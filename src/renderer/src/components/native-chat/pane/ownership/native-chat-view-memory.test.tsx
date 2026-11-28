// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  releaseNativeChatViewTabs,
  writeNativeChatViewMemory
} from './native-chat-view-memory'
import { useNativeChatConversationKey } from '../../conversation/projection/use-native-chat-conversation-key'
import { useNativeChatReadingPosition } from '../../viewport/navigation/use-native-chat-reading-position'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }

function setTabs(ids: readonly string[]): void {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
      [TAB.worktreeId]: ids.map((id) => ({ id }) as Tab)
    }
  })
}

const inTab = ({ children }: { children: ReactNode }) => (
  <NativeChatViewTabContext value={TAB}>{children}</NativeChatViewTabContext>
)

beforeEach(() => setTabs([TAB.tabId]))
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('keeps a write made before any layer registered the tab, and drops writes after its release', () => {
  writeNativeChatViewMemory(TAB, 'first', 1)
  expect(readNativeChatViewMemory(TAB, 'first')).toBe(1)
  // The tab closes and its state is released, as the closed-tab sweep does.
  setTabs([])
  releaseNativeChatViewTabs([TAB.tabId])
  writeNativeChatViewMemory(TAB, 'late', 2)
  expect(readNativeChatViewMemory(TAB, 'late')).toBeUndefined()
})

it('a chat remounted after a /clear finds its conversation once its epoch loads', () => {
  type Props = { epoch: string | null; clears: number }
  const useConversation = (props: Props) => useNativeChatConversationKey(props.epoch, props.clears)
  const atClear: Props = { epoch: 'e1', clears: 1 }
  const remounted: Props = { epoch: null, clears: 0 }
  const first = renderHook(useConversation, { wrapper: inTab, initialProps: atClear })
  expect(first.result.current).toBe('e1:1')
  first.unmount()
  const again = renderHook(useConversation, { wrapper: inTab, initialProps: remounted })
  again.rerender({ epoch: 'e1', clears: 0 })
  expect(again.result.current).toBe('e1:1')
})

it('typing into kept state reads the tab store once, not on every keystroke', () => {
  const read = vi.spyOn(useAppStore, 'getState')
  for (let keystroke = 0; keystroke < 100; keystroke++) {
    writeNativeChatViewMemory(TAB, 'find-query', `q${keystroke}`)
  }
  expect(read).toHaveBeenCalledTimes(1)
  read.mockRestore()
})

it('a restore that never reads history keeps its bookmark through the next hide', () => {
  // Each retry waits a frame; run them at once.
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frame(0)
    return 0
  })
  const bookmark = { messageId: 'row-30', offset: 12 }
  writeNativeChatViewMemory(TAB, 'reading-position:t', bookmark)
  const jumpTo = vi.fn((_position: unknown, settled: (result: 'superseded') => void) =>
    settled('superseded')
  )
  const props = { isVisible: true }
  const view = renderHook(
    ({ isVisible }: { isVisible: boolean }) =>
      useNativeChatReadingPosition({
        positionKey: 't',
        isVisible,
        ready: true,
        scrollRef: { current: document.createElement('div') },
        readerAtEnd: () => true,
        messageIdAt: () => null,
        waitingMessageIdAt: () => null,
        jumpTo,
        onGiveUp: () => {}
      }),
    { wrapper: inTab, initialProps: props }
  )
  const tries = jumpTo.mock.calls.length
  expect(tries).toBe(5)
  view.rerender({ isVisible: false })
  expect(readNativeChatViewMemory(TAB, 'reading-position:t')).toEqual(bookmark)
  view.rerender({ isVisible: true })
  expect(jumpTo.mock.calls.length).toBe(tries)
  expect(readNativeChatViewMemory(TAB, 'reading-position:t')).toEqual(bookmark)
  vi.unstubAllGlobals()
})
