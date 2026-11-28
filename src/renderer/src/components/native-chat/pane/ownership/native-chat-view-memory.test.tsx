// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  releaseNativeChatViewTabs,
  writeNativeChatViewMemory
} from './native-chat-view-memory'
import { useNativeChatConversationKey } from '../../conversation/projection/use-native-chat-conversation-key'

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

it('keeps a write made before any layer registered the tab, and drops writes once it closed', () => {
  writeNativeChatViewMemory(TAB, 'first', 1)
  expect(readNativeChatViewMemory(TAB, 'first')).toBe(1)
  setTabs([])
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
