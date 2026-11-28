// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { PairedServerAskCard } from '../../../../../shared/rpc-contract/paired-server-asks-params'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../pane/ownership/native-chat-view-memory'
import { usePairedServerAskDecisions } from './use-paired-server-ask-decisions'

// A decision still on its way: the host never answers in this test.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () => new Promise(() => {})
}))

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

it('a paired-server decision still sending holds its buttons when the chat returns', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deciding reads only the message id.
  const card = { messageId: 'ask-1' } as PairedServerAskCard
  const first = renderHook(() => usePairedServerAskDecisions(), { wrapper: inTab })
  act(() => first.result.current.decide(card, 'once'))
  first.unmount()
  const again = renderHook(() => usePairedServerAskDecisions(), { wrapper: inTab })
  expect(again.result.current.submitting.get('ask-1')).toBe('once')
})
