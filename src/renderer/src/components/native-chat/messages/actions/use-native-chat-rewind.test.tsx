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

it('a chat released mid-rewind returns still refusing sends', async () => {
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
    send: () => new Promise<never>(() => {})
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
  const again = renderHook(() => useNativeChatRewind(input), { wrapper: inTab })
  expect(again.result.current.admitsSend()).toBe(false)
})
