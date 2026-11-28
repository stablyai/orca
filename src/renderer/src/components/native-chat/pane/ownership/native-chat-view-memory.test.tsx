// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  onNativeChatViewTabRelease,
  releaseNativeChatViewTabs,
  useNativeChatViewGuardRef,
  useNativeChatViewState,
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
  const props = { isVisible: true, positionKey: 't' }
  const view = renderHook(
    ({ isVisible, positionKey }: { isVisible: boolean; positionKey: string }) =>
      useNativeChatReadingPosition({
        positionKey,
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
  view.rerender({ isVisible: false, positionKey: 't' })
  expect(readNativeChatViewMemory(TAB, 'reading-position:t')).toEqual(bookmark)
  view.rerender({ isVisible: true, positionKey: 't' })
  expect(jumpTo.mock.calls.length).toBe(tries)
  expect(readNativeChatViewMemory(TAB, 'reading-position:t')).toEqual(bookmark)
  // Another transcript in the same view clears its own stale bookmark as usual.
  writeNativeChatViewMemory(TAB, 'reading-position:u', bookmark)
  view.rerender({ isVisible: true, positionKey: 'u' })
  expect(readNativeChatViewMemory(TAB, 'reading-position:u')).toBeUndefined()
  vi.unstubAllGlobals()
})

it('a request from a closed tab never touches the same tab id opened again', () => {
  const first = renderHook(() => useNativeChatViewState('busy', false), { wrapper: inTab })
  act(() => first.result.current[1](true))
  const lateSettle = first.result.current[1]
  first.unmount()
  releaseNativeChatViewTabs([TAB.tabId])
  // The id opens again, as a restored launch slot can, and starts its own request.
  const again = renderHook(() => useNativeChatViewState('busy', false), { wrapper: inTab })
  act(() => again.result.current[1](true))
  act(() => lateSettle(false))
  expect(again.result.current[0]).toBe(true)
})

it('the newest-few cap drops settled entries, never one still in flight', () => {
  writeNativeChatViewMemory(TAB, 'answer:0', { inFlight: true }, 2)
  for (let index = 1; index <= 4; index++) {
    writeNativeChatViewMemory(TAB, `answer:${index}`, { inFlight: false }, 2)
  }
  expect(readNativeChatViewMemory(TAB, 'answer:0')).toEqual({ inFlight: true })
  expect(readNativeChatViewMemory(TAB, 'answer:1')).toBeUndefined()
  expect(readNativeChatViewMemory(TAB, 'answer:4')).toEqual({ inFlight: false })
})

it('a view leaving open work on a switch checks only its own workspace, not every tab', () => {
  const walk = vi.spyOn(Object, 'values')
  const cancel = onNativeChatViewTabRelease(TAB, () => {})
  expect(walk).not.toHaveBeenCalled()
  walk.mockRestore()
  cancel()
})

it('a guard kept as a ref keeps nothing once it settles', () => {
  const view = renderHook(() => useNativeChatViewGuardRef('command-pending', false), {
    wrapper: inTab
  })
  act(() => {
    view.result.current.current = true
  })
  expect(view.result.current.current).toBe(true)
  act(() => {
    view.result.current.current = false
  })
  expect(readNativeChatViewMemory(TAB, 'command-pending')).toBeUndefined()
})
