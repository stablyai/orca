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
} from '../../pane/ownership/native-chat-view-memory'
import { useNativeChatNewRowsMarker } from './native-chat-new-rows-marker'

// The window holds focus, so a shown transcript is being watched.
vi.mock('@/attention/use-orca-window-foreground-focused', () => ({
  useOrcaWindowForegroundFocused: () => true
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

it("switching transcripts in one view keeps each transcript's own place", () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the marker reads only this setting.
  useAppStore.setState({ settings: { nativeChatMarkNewMessages: true } as never })
  const position = { sequence: 1, index: 0 }
  const subagentMissed = { key: 'row-x', after: position, through: position }
  writeNativeChatViewMemory(TAB, 'new-rows:sub', {
    watching: true,
    left: null,
    missed: subagentMissed,
    arriving: true
  })
  const view = renderHook(
    ({ transcript }: { transcript: string }) =>
      useNativeChatNewRowsMarker([], [], true, transcript),
    { wrapper: inTab, initialProps: { transcript: 'main' } }
  )
  view.rerender({ transcript: 'sub' })
  expect(readNativeChatViewMemory<{ missed: unknown }>(TAB, 'new-rows:main')?.missed).toBeNull()
  expect(readNativeChatViewMemory<{ missed: unknown }>(TAB, 'new-rows:sub')?.missed).toEqual(
    subagentMissed
  )
})
