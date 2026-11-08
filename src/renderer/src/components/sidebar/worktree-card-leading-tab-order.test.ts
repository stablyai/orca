// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { orderWorktreeLeadingTabs } from './worktree-card-leading-tab-order'

afterEach(() => vi.useRealTimers())
it('ranks native sessions by attention in Smart mode and by their status event in Recent mode', () => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  const native = makeUnifiedTab({
    id: 'native',
    entityId: 'session',
    worktreeId: 'workspace',
    groupId: 'group',
    contentType: 'agent-session',
    lastFocusedAt: 1_000_000
  })
  const terminal = makeUnifiedTab({
    id: 'unified-terminal',
    entityId: 'terminal',
    worktreeId: 'workspace',
    groupId: 'group',
    lastFocusedAt: 1_990_000
  })
  const status = (
    paneKey: string,
    state: AgentStatusEntry['state'],
    stateStartedAt: number
  ): AgentStatusEntry => ({
    paneKey,
    worktreeId: 'workspace',
    agentType: 'codex',
    state,
    stateStartedAt,
    updatedAt: 2_000_000,
    stateHistory: [],
    prompt: ''
  })
  const nativeKey = structuredAgentSessionPaneKey(native.id, native.entityId)
  const terminalKey = makePaneKey('terminal', '11111111-1111-4111-8111-111111111111')
  const state = {
    ...useAppStore.getState(),
    sortBy: 'smart' as const,
    unifiedTabsByWorktree: { workspace: [terminal, native] },
    tabsByWorktree: { workspace: [makeTab({ id: 'terminal', worktreeId: 'workspace' })] },
    agentStatusByPaneKey: {
      [nativeKey]: status(nativeKey, 'waiting', 1_995_000),
      [terminalKey]: status(terminalKey, 'working', 1_900_000)
    },
    migrationUnsupportedByPtyId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {},
    worktreesByRepo: {}
  }
  expect(orderWorktreeLeadingTabs(state, 'workspace').map((tab) => tab.id)).toEqual([
    'native',
    'unified-terminal'
  ])
  expect(
    orderWorktreeLeadingTabs({ ...state, sortBy: 'recent' }, 'workspace').map((tab) => tab.id)
  ).toEqual(['native', 'unified-terminal'])
  const stale = {
    ...state,
    agentStatusByPaneKey: {
      ...state.agentStatusByPaneKey,
      [nativeKey]: status(nativeKey, 'waiting', 1),
      [structuredAgentSessionPaneKey(native.id, 'older-session')]: status(
        structuredAgentSessionPaneKey(native.id, 'older-session'),
        'waiting',
        1_999_000
      )
    }
  }
  stale.agentStatusByPaneKey[nativeKey]!.updatedAt = 1
  expect(orderWorktreeLeadingTabs(stale, 'workspace').map((tab) => tab.id)).toEqual([
    'unified-terminal',
    'native'
  ])
})
