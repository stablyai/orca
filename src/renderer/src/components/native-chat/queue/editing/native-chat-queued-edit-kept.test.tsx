// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../../pane/ownership/native-chat-view-memory'
import { createNativeChatQueuedEditDraft } from './native-chat-queued-edit-draft'
import {
  useKeptNativeChatQueuedEdit,
  useNativeChatQueuedEditLifetime,
  type NativeChatQueuedEditSession
} from './native-chat-queued-edit-session'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }
const inTab = ({ children }: { children: ReactNode }) => (
  <NativeChatViewTabContext value={TAB}>{children}</NativeChatViewTabContext>
)
const setTabs = (ids: readonly string[]) =>
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
    unifiedTabsByWorktree: { [TAB.worktreeId]: ids.map((id) => ({ id }) as Tab) }
  })

beforeEach(() => setTabs([TAB.tabId]))
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('a chat released mid-edit keeps the edit open for its next view, and the tab closing hands it back', () => {
  const close = vi.fn((edit?: NativeChatQueuedEditSession | null) => void edit)
  const view = () =>
    renderHook(
      () => {
        const kept = useKeptNativeChatQueuedEdit()
        useNativeChatQueuedEditLifetime({
          scope: 'scope',
          shownScope: undefined,
          active: kept.activeRef,
          reopen: kept.reopenRef,
          close,
          render: () => {}
        })
        return kept
      },
      { wrapper: inTab }
    )
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'draft' }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hand-back reads the draft fields, scope and lease only.
  const edit = {
    ...createNativeChatQueuedEditDraft(body, 'chat-draft'),
    scope: 'scope',
    uncertain: false,
    lease: { end: () => {} }
  } as unknown as NativeChatQueuedEditSession
  const first = view()
  first.result.current.activeRef.current = edit
  first.unmount()
  expect(close).not.toHaveBeenCalled()
  const again = view()
  expect(again.result.current.activeRef.current).toBe(edit)
  again.unmount()
  setTabs([])
  releaseNativeChatViewTabs([TAB.tabId])
  expect(close).toHaveBeenCalledWith(edit)
})

it('an edit left in a released chat is handed back on reload, and kept when its tab moves workspace', () => {
  const close = vi.fn((edit?: NativeChatQueuedEditSession | null) => void edit)
  const mount = (tab: { tabId: string; worktreeId: string }) =>
    renderHook(
      () => {
        const kept = useKeptNativeChatQueuedEdit()
        useNativeChatQueuedEditLifetime({
          scope: 'scope',
          shownScope: undefined,
          active: kept.activeRef,
          reopen: kept.reopenRef,
          close,
          render: () => {}
        })
        return kept
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <NativeChatViewTabContext value={tab}>{children}</NativeChatViewTabContext>
        )
      }
    )
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'draft' }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hand-back reads the draft fields, scope and lease only.
  const edit = {
    ...createNativeChatQueuedEditDraft(body, 'chat-draft'),
    scope: 'scope',
    uncertain: false,
    lease: { end: () => {} }
  } as unknown as NativeChatQueuedEditSession
  const first = mount(TAB)
  first.result.current.activeRef.current = edit
  // The tab moves to another workspace, as a rename does, and its old view unmounts.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  useAppStore.setState({ unifiedTabsByWorktree: { 'wt-2': [{ id: TAB.tabId } as Tab] } })
  first.unmount()
  expect(close).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('pagehide'))
  expect(close).toHaveBeenCalledWith(edit)
})
