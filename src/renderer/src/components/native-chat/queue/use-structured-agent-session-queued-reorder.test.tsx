// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../pane/ownership/native-chat-view-memory'
import type { QueuedEditTransport } from './editing/native-chat-queued-edit-session'
import { useStructuredAgentSessionQueuedReorder } from './use-structured-agent-session-queued-reorder'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }
const inTab = ({ children }: { children: ReactNode }) => (
  <NativeChatViewTabContext value={TAB}>{children}</NativeChatViewTabContext>
)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a move reads only a card's id and hold.
const card = (messageId: string) => ({ messageId, hold: 'turn' }) as QueuedMessageCard
const CARDS = [card('a'), card('b')]

beforeEach(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  useAppStore.setState({ unifiedTabsByWorktree: { [TAB.worktreeId]: [{ id: TAB.tabId } as Tab] } })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('a chat released mid-move returns still moving: its preview stays and a second move is refused', () => {
  const write = vi.fn(() => new Promise<never>(() => {}))
  const transport: QueuedEditTransport = {
    target: { kind: 'local' },
    sessionId: 's',
    capable: true,
    reorderCapable: true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move never settles, so its result type is never read.
    write: write as unknown as QueuedEditTransport['write']
  }
  // A remount rebuilds the cards: equal ones, in new arrays.
  const view = (cards: QueuedMessageCard[]) =>
    renderHook(
      () => useStructuredAgentSessionQueuedReorder(cards, cards, transport, () => () => true),
      { wrapper: inTab }
    )
  const first = view(CARDS)
  act(() => void first.result.current.reorder!.move('b', { beforeMessageId: 'a' }))
  first.unmount()
  const again = view([card('a'), card('b')])
  expect(again.result.current.reorder!.pending).toBe(true)
  expect(again.result.current.cards.map((each) => each.messageId)).toEqual(['b', 'a'])
  act(() => void again.result.current.reorder!.move('a', { beforeMessageId: 'b' }))
  expect(write).toHaveBeenCalledTimes(1)
})
