import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  readNativeChatViewMemory,
  releaseNativeChatViewTabs,
  writeNativeChatViewMemory
} from '../ownership/native-chat-view-memory'
import { forgetChatLayer, reportChatLayerTabs } from './native-chat-closed-tab-release'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }

afterEach(() => releaseNativeChatViewTabs([TAB.tabId, 'tab-r', 'tab-m']))

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
