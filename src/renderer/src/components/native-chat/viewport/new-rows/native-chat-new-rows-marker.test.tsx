// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  releaseNativeChatViewTabs
} from '../../pane/ownership/native-chat-view-memory'
import { useNativeChatNewRowsMarker } from './native-chat-new-rows-marker'

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

it('keeps no new-message place while marking new messages is off', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the marker reads only this setting.
  const settings = (on: boolean) => ({ nativeChatMarkNewMessages: on }) as never
  useAppStore.setState({ settings: settings(false) })
  renderHook(() => useNativeChatNewRowsMarker([], [], true, 'off'), { wrapper: inTab })
  expect(readNativeChatViewMemory(TAB, 'new-rows:off')).toBeUndefined()
  useAppStore.setState({ settings: settings(true) })
  renderHook(() => useNativeChatNewRowsMarker([], [], false, 'on'), { wrapper: inTab })
  expect(readNativeChatViewMemory(TAB, 'new-rows:on')).toBeDefined()
})
