// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { useNativeChatOpenSubagent } from '@/components/native-chat/subagents/native-chat-open-subagent'
import { viewClaudeAgentFromRow } from './claude-agent-row-view'

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ agentStatusByPaneKey: {} }) }
}))

function childRow(agentType: string): DashboardAgentRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the routing reads only these fields of the row.
  return {
    paneKey: 'tab-1:chat\u0000subagent:row-1',
    activationPaneKey: 'tab-1:chat',
    rowSource: 'subagent',
    entry: { agentType, structuredHostOwned: true, paneKey: 'tab-1:chat' },
    childRow: { id: 'row-1', providerId: 'thread-child' }
  } as unknown as DashboardAgentRow
}

describe('viewClaudeAgentFromRow', () => {
  it("opens a chat pane's subagent row in that chat's subagent view, for any agent", async () => {
    const { result } = renderHook(() => useNativeChatOpenSubagent('tab-1:chat'))
    await act(() => viewClaudeAgentFromRow(childRow('codex')))
    expect(result.current?.agentId).toBe('thread-child')
  })
})
