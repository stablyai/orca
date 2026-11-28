// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { showFramePatch } from '@/store/slices/tabs/moved-tab-selection'
import {
  chatPaneAddressTabId,
  chatPaneKey
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  openNativeChatSubagent,
  retireNativeChatSubagentViews,
  useNativeChatOpenSubagent
} from '../../subagents/native-chat-open-subagent'
import {
  readNativeChatViewMemory,
  releaseNativeChatViewTabs,
  writeNativeChatViewMemory
} from '../ownership/native-chat-view-memory'
import { forgetChatLayer, reportChatLayerTabs } from './native-chat-closed-tab-release'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }
const SESSION = 'session-cross-workspace'
const SHEET_PANE = chatPaneKey(SESSION)

afterEach(() => {
  cleanup()
  retireNativeChatSubagentViews(chatPaneAddressTabId(SESSION))
  releaseNativeChatViewTabs([TAB.tabId, 'tab-r', 'tab-m', 'tab-c'])
})

function chatTab(id: string, worktreeId: string, entityId = id): Tab {
  return {
    id,
    worktreeId,
    entityId,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    groupId: `group-${worktreeId}`,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

it('releases a tab closed in a shown workspace and keeps the open ones', () => {
  const two = { tabId: 'tab-2', worktreeId: TAB.worktreeId }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  const tab = (id: string): Tab => ({ id }) as Tab
  useAppStore.setState({
    unifiedTabsByWorktree: { [TAB.worktreeId]: [tab(TAB.tabId), tab(two.tabId)] }
  })
  reportChatLayerTabs('layer-a', TAB.worktreeId, new Set([TAB.tabId, two.tabId]))
  writeNativeChatViewMemory(TAB, 'kept', 1)
  writeNativeChatViewMemory(two, 'kept', 1)
  useAppStore.setState({ unifiedTabsByWorktree: { [TAB.worktreeId]: [tab(TAB.tabId)] } })
  reportChatLayerTabs('layer-a', TAB.worktreeId, new Set([TAB.tabId]))
  expect(readNativeChatViewMemory(two, 'kept')).toBeUndefined()
  expect(readNativeChatViewMemory(TAB, 'kept')).toBe(1)
  forgetChatLayer('layer-a', TAB.worktreeId)
  expect(readNativeChatViewMemory(TAB, 'kept')).toBe(1)
})

it('a workspace removed while no layer showed it is released by a later unmount elsewhere', () => {
  const gone = { tabId: 'tab-9', worktreeId: 'wt-9' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  const tab = (id: string): Tab => ({ id }) as Tab
  useAppStore.setState({ unifiedTabsByWorktree: { 'wt-9': [tab('tab-9')], 'wt-1': [] } })
  reportChatLayerTabs('layer-9', 'wt-9', new Set(['tab-9']))
  writeNativeChatViewMemory(gone, 'kept', 1)
  forgetChatLayer('layer-9', 'wt-9')
  useAppStore.setState({ unifiedTabsByWorktree: { 'wt-1': [] } })
  reportChatLayerTabs('layer-1', 'wt-1', new Set())
  forgetChatLayer('layer-1', 'wt-1')
  expect(readNativeChatViewMemory(gone, 'kept')).toBeUndefined()
})

it('a renamed workspace or a tab moved to another keeps its open chats, and releases them once closed', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  const tab = (id: string): Tab => ({ id }) as Tab
  const renamed = { tabId: 'tab-r', worktreeId: 'wt-old' }
  const moved = { tabId: 'tab-m', worktreeId: 'wt-m' }
  useAppStore.setState({
    unifiedTabsByWorktree: { 'wt-old': [tab('tab-r')], 'wt-m': [tab('tab-m')] }
  })
  reportChatLayerTabs('layer-old', 'wt-old', new Set(['tab-r']))
  reportChatLayerTabs('layer-m', 'wt-m', new Set(['tab-m']))
  writeNativeChatViewMemory(renamed, 'kept', 1)
  writeNativeChatViewMemory(moved, 'kept', 1)
  // The rename moves the tab to the new id; a drag moves tab-m out of its workspace.
  useAppStore.setState({
    unifiedTabsByWorktree: { 'wt-new': [tab('tab-r'), tab('tab-m')], 'wt-m': [] }
  })
  reportChatLayerTabs('layer-m', 'wt-m', new Set())
  forgetChatLayer('layer-old', 'wt-old')
  forgetChatLayer('layer-m', 'wt-m')
  expect(readNativeChatViewMemory(renamed, 'kept')).toBe(1)
  expect(readNativeChatViewMemory(moved, 'kept')).toBe(1)
  // Both close later in their new workspace, with no layer showing it: still released.
  useAppStore.setState({ unifiedTabsByWorktree: { 'wt-new': [], 'wt-1': [] } })
  reportChatLayerTabs('layer-1', 'wt-1', new Set())
  forgetChatLayer('layer-1', 'wt-1')
  expect(readNativeChatViewMemory(renamed, 'kept')).toBeUndefined()
  expect(readNativeChatViewMemory(moved, 'kept')).toBeUndefined()
})

it('releases a closed chat and preserves a moved chat’s sheet and view memory', async () => {
  const closed = { tabId: 'tab-c', worktreeId: 'wt-c' }
  const moved = { tabId: 'tab-m', worktreeId: 'wt-c' }
  useAppStore.setState({
    unifiedTabsByWorktree: { 'wt-c': [chatTab('tab-c', 'wt-c'), chatTab('tab-m', 'wt-c', SESSION)] }
  })
  writeNativeChatViewMemory(closed, 'kept', 1)
  writeNativeChatViewMemory(moved, 'kept', 1)
  openNativeChatSubagent(SHEET_PANE, 'agent-1')
  const { result } = renderHook(() => useNativeChatOpenSubagent(SHEET_PANE))
  act(() => {
    showFramePatch(
      useAppStore,
      { unifiedTabsByWorktree: { 'wt-c': [], 'wt-x': [chatTab('tab-m', 'wt-x', SESSION)] } },
      ['wt-c', 'wt-x']
    )
  })
  await Promise.resolve()
  expect(readNativeChatViewMemory(closed, 'kept')).toBeUndefined()
  expect(readNativeChatViewMemory(moved, 'kept')).toBe(1)
  expect(result.current?.agentId).toBe('agent-1')
})

it('keeps the sheet until the last workspace view is removed', () => {
  const otherView = [chatTab('tab-b', 'wt-b', SESSION)]
  useAppStore.setState({
    unifiedTabsByWorktree: { 'wt-a': [chatTab('tab-a', 'wt-a', SESSION)], 'wt-b': otherView }
  })
  openNativeChatSubagent(SHEET_PANE, 'agent-2')
  const { result } = renderHook(() => useNativeChatOpenSubagent(SHEET_PANE))
  act(() => {
    showFramePatch(useAppStore, { unifiedTabsByWorktree: { 'wt-b': otherView } }, ['wt-a'])
  })
  expect(result.current?.agentId).toBe('agent-2')
  act(() => {
    showFramePatch(useAppStore, { unifiedTabsByWorktree: {} }, ['wt-b'])
  })
  expect(result.current).toBeNull()
})

it('an unmount checks a bounded number of workspaces however many layers are shown', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  const tab = (id: string): Tab => ({ id }) as Tab
  const shown = Array.from({ length: 1000 }, (_, index) => `wt-shown-${index}`)
  useAppStore.setState({
    unifiedTabsByWorktree: Object.fromEntries(shown.map((id) => [id, [tab(`${id}-tab`)]]))
  })
  shown.forEach((id) => reportChatLayerTabs(`layer-${id}`, id, new Set([`${id}-tab`])))
  reportChatLayerTabs('layer-leaving', 'wt-leaving', new Set())
  const has = vi.spyOn(Set.prototype, 'has')
  const get = vi.spyOn(Map.prototype, 'get')
  forgetChatLayer('layer-leaving', 'wt-leaving')
  expect(has.mock.calls.length + get.mock.calls.length).toBeLessThan(100)
  has.mockRestore()
  get.mockRestore()
  // Closed before their layers go, so each unmount releases its own and leaves nothing tracked.
  useAppStore.setState({ unifiedTabsByWorktree: {} })
  shown.forEach((id) => forgetChatLayer(`layer-${id}`, id))
})

it('workspaces that never had a chat tab leave no entry to crowd out the next sweep', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  const tab = (id: string): Tab => ({ id }) as Tab
  const empty = Array.from({ length: 20 }, (_, index) => `wt-room-${index}`)
  const closed = { tabId: 'tab-z', worktreeId: 'wt-z' }
  useAppStore.setState({ unifiedTabsByWorktree: { 'wt-z': [tab('tab-z')] } })
  reportChatLayerTabs('layer-z', 'wt-z', new Set(['tab-z']))
  writeNativeChatViewMemory(closed, 'kept', 1)
  empty.forEach((id) => reportChatLayerTabs(`layer-${id}`, id, new Set()))
  empty.forEach((id) => forgetChatLayer(`layer-${id}`, id))
  forgetChatLayer('layer-z', 'wt-z')
  // tab-z closes while no layer shows its workspace; one unmount elsewhere finds it.
  useAppStore.setState({ unifiedTabsByWorktree: { 'wt-z': [] } })
  reportChatLayerTabs('layer-other', 'wt-other', new Set())
  forgetChatLayer('layer-other', 'wt-other')
  expect(readNativeChatViewMemory(closed, 'kept')).toBeUndefined()
})
