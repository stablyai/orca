// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { ConfirmationDialogContextValue } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../../pane/ownership/native-chat-view-memory'
import { useNativeChatRewind } from './use-native-chat-rewind'
import type { StructuredAgentSessionWriteOutcome } from '../../session/structured/writes/use-structured-agent-session-mutate'
import type { AgentSessionRewindResult } from '../../../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'

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

it('a chat released mid-rewind keeps refusing sends until the rewound conversation loads', async () => {
  const sent = Promise.withResolvers<StructuredAgentSessionWriteOutcome<AgentSessionRewindResult>>()
  const input = {
    sessionId: 'session',
    capturePresentation: () => () => true,
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'e1',
      fence: 1,
      status: 'ready' as const,
      items: [
        {
          itemId: 'user-1',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message' as const, role: 'user' as const, blocks: [] }
        }
      ]
    },
    support: { supported: true as const },
    blocked: false,
    send: () => sent.promise
  }
  const first = renderHook(() => useNativeChatRewind(input), { wrapper: inTab })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rewind only awaits the confirm's answer.
  const confirm = (() => Promise.resolve(true)) as unknown as ConfirmationDialogContextValue
  await act(async () => {
    void first.result.current.request('user-1', confirm)
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
  })
  expect(first.result.current.admitsSend()).toBe(false)
  first.unmount()
  // Remounted before history arrived: no epoch yet.
  const cold = { ...input, state: { ...input.state, epoch: null } }
  const again = renderHook(() => useNativeChatRewind(cold), { wrapper: inTab })
  expect(again.result.current.admitsSend()).toBe(false)
  await act(async () => {
    sent.resolve({ kind: 'done', value: { itemId: 'user-1', epoch: 'e2', sequence: 5 } })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
  })
  expect(again.result.current.admitsSend()).toBe(false)
  // The rewound conversation loads; a later remount before history arrives holds nothing.
  again.unmount()
  const loaded = renderHook(
    () => useNativeChatRewind({ ...input, state: { ...input.state, epoch: 'e2' } }),
    { wrapper: inTab }
  )
  expect(loaded.result.current.admitsSend()).toBe(true)
  loaded.unmount()
  const later = renderHook(() => useNativeChatRewind(cold), { wrapper: inTab })
  expect(later.result.current.admitsSend()).toBe(true)
})

it("a rewind reply landing after the tab moved to another conversation never blocks that conversation's sends", async () => {
  const sent = Promise.withResolvers<StructuredAgentSessionWriteOutcome<AgentSessionRewindResult>>()
  const showing = (conversation: string) =>
    function InConversation({ children }: { children: ReactNode }) {
      return (
        <NativeChatViewTabContext value={{ ...TAB, conversation }}>
          {children}
        </NativeChatViewTabContext>
      )
    }
  const state = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: 'e1',
    fence: 1,
    status: 'ready' as const,
    items: [
      {
        itemId: 'user-1',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message' as const, role: 'user' as const, blocks: [] }
      }
    ]
  }
  const input = {
    sessionId: 'session-a',
    capturePresentation: () => () => true,
    state,
    support: { supported: true as const },
    blocked: false,
    send: () => sent.promise
  }
  const first = renderHook(() => useNativeChatRewind(input), { wrapper: showing('claude:a') })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rewind only awaits the confirm's answer.
  const confirm = (() => Promise.resolve(true)) as unknown as ConfirmationDialogContextValue
  await act(async () => {
    void first.result.current.request('user-1', confirm)
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
  })
  first.unmount()
  const other = renderHook(() => useNativeChatRewind({ ...input, sessionId: 'session-b' }), {
    wrapper: showing('claude:b')
  })
  await act(async () => {
    sent.resolve({ kind: 'done', value: { itemId: 'user-1', epoch: 'e2', sequence: 5 } })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
  })
  expect(other.result.current.admitsSend()).toBe(true)
})
