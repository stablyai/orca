// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeCreatedAgentWorktree,
  seedAlreadyActiveWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeCardSlotAgentLines } from './WorktreeCardSlotAgentLines'
import { buildSlotAgentSignals } from './worktree-card-slot-agent-signals'
import { createWorktreeAgentRowsSelector } from './workspace-card/activity/worktree-agent-rows-projection'
import { openSlotTarget } from './worktree-card-slot-targets'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => ({ ok: true }))
}))

const original = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
})

it('opens an expanded live agent on the card host when another host has the same workspace ID', () => {
  const worktree = { ...makeCreatedAgentWorktree(), hostId: 'local' as const }
  const now = Date.now()
  const paneKey = makePaneKey('tab-1', LEAF)
  seedAlreadyActiveWorktree(worktree, {
    worktreesByRepo: { [worktree.repoId]: [worktree, { ...worktree, hostId: 'runtime:other' }] },
    activeWorkspaceExecutionHostId: 'runtime:other',
    terminalLayoutsByTabId: {
      'tab-1': { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        worktreeId: worktree.id,
        agentType: 'codex',
        state: 'working',
        prompt: 'Local agent',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }
    }
  })
  const agents = createWorktreeAgentRowsSelector(worktree.id, 'local')(useAppStore.getState())
  render(
    <TooltipProvider>
      <WorktreeCardSlotAgentLines
        worktreeId={worktree.id}
        executionHostId="local"
        agents={agents}
        signals={buildSlotAgentSignals(agents, [])}
        now={now}
        offline={false}
        cacheTimersActive={false}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Local agent/ }))
  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
  expect(useAppStore.getState().getActiveTab(worktree.id)?.id).toBe('tab-1')
})

it('opens the structured chat tab from a slot target whose tab ID contains a collision suffix', () => {
  const worktree = { ...makeCreatedAgentWorktree(), hostId: 'local' as const }
  seedAlreadyActiveWorktree(worktree)
  const tabId = 'structured-agent-session-chat:history-1'
  const paneKey = structuredAgentSessionPaneKey(tabId, 'chat')
  useAppStore.setState({
    activeTabType: 'terminal',
    groupsByWorktree: {
      [worktree.id]: [
        { ...useAppStore.getState().groupsByWorktree[worktree.id][0], tabOrder: ['tab-1', tabId] }
      ]
    },
    unifiedTabsByWorktree: {
      [worktree.id]: [
        ...useAppStore.getState().unifiedTabsByWorktree[worktree.id],
        {
          id: tabId,
          worktreeId: worktree.id,
          executionHostId: 'local',
          groupId: 'group-1',
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          entityId: 'chat',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        }
      ]
    }
  })
  openSlotTarget({
    worktreeId: worktree.id,
    executionHostId: 'local',
    paneKey,
    kind: 'working',
    at: 1,
    retained: false,
    agentType: 'codex',
    entry: null
  })
  expect(useAppStore.getState().activeTabType).toBe('agent-session')
  expect(useAppStore.getState().getActiveTab(worktree.id)?.id).toBe(
    'structured-agent-session-chat:history-1'
  )
})
