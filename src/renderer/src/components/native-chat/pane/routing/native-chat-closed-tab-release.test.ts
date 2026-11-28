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

afterEach(() => releaseNativeChatViewTabs([TAB.tabId]))

it('releases closed chat tabs by workspace, never walking other workspaces', () => {
  const two = { tabId: 'tab-2', worktreeId: TAB.worktreeId }
  const elsewhere = { tabId: 'tab-3', worktreeId: 'wt-2' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  const tab = (id: string): Tab => ({ id }) as Tab
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [TAB.worktreeId]: [tab(TAB.tabId), tab(two.tabId)],
      'wt-2': [tab('tab-3')]
    }
  })
  reportChatLayerTabs('layer-a', TAB.worktreeId, new Set([TAB.tabId, two.tabId]))
  reportChatLayerTabs('layer-b', 'wt-2', new Set(['tab-3']))
  for (const each of [TAB, two, elsewhere]) {
    writeNativeChatViewMemory(each, 'kept', 1)
  }
  forgetChatLayer('layer-b', 'wt-2')
  // tab-3 closes while its workspace has no layer; tab-2 closes in a shown workspace.
  useAppStore.setState({
    unifiedTabsByWorktree: { [TAB.worktreeId]: [tab(TAB.tabId)], 'wt-2': [] }
  })
  reportChatLayerTabs('layer-a', TAB.worktreeId, new Set([TAB.tabId]))
  forgetChatLayer('layer-a', TAB.worktreeId)
  expect(readNativeChatViewMemory(two, 'kept')).toBeUndefined()
  expect(readNativeChatViewMemory(elsewhere, 'kept')).toBe(1)
  expect(readNativeChatViewMemory(TAB, 'kept')).toBe(1)
  // Its workspace shown again: the tab that closed meanwhile is released.
  reportChatLayerTabs('layer-b2', 'wt-2', new Set())
  expect(readNativeChatViewMemory(elsewhere, 'kept')).toBeUndefined()
  forgetChatLayer('layer-b2', 'wt-2')
})
