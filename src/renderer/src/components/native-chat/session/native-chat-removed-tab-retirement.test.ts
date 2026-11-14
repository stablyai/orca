// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { makeUnifiedTab } from '../../../store/slices/tabs/tab-group.test-fixture'
import {
  openNativeChatSubagent,
  useNativeChatOpenSubagent
} from '../subagents/native-chat-open-subagent'
import { retireRemovedNativeChatTabs } from './native-chat-removed-tab-retirement'

const chat = (id: string) =>
  makeUnifiedTab({
    id,
    worktreeId: 'wt-1',
    groupId: 'group-1',
    entityId: `session-${id}`,
    contentType: 'agent-session'
  })

it('drops a closed chat tab’s open subagent and keeps the other tabs’', () => {
  const closed = chat('tab-closed')
  const kept = chat('tab-kept')
  act(() => {
    openNativeChatSubagent('tab-closed:pane', 'agent-1')
    openNativeChatSubagent('tab-kept:pane', 'agent-2')
  })
  const closedView = renderHook(() => useNativeChatOpenSubagent('tab-closed:pane'))
  const keptView = renderHook(() => useNativeChatOpenSubagent('tab-kept:pane'))

  act(() => retireRemovedNativeChatTabs([closed, kept], [kept]))

  expect(closedView.result.current).toBeNull()
  expect(keptView.result.current).toEqual({ agentId: 'agent-2', parentId: null })
})
