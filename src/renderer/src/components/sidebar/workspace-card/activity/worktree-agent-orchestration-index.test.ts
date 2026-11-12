import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import {
  EMPTY_WORKTREE_AGENT_ORCHESTRATION,
  releaseWorktreeAgentOrchestrationIndexCache,
  selectWorktreeAgentOrchestration
} from './worktree-agent-orchestration-index'

type IndexState = Parameters<typeof selectWorktreeAgentOrchestration>[0]

// Include __proto__ because ordinary object assignment can treat it as a prototype mutation.

// Define __proto__ as data rather than invoking the object prototype setter.

/** Use the pre-index selector as an independent oracle, correcting only __proto__ storage with a null-prototype record. */

// Seed the differential test so failures reproduce exactly.

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'unused',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function paneKeyFor(tabId: string, index: number): string {
  return makePaneKey(tabId, `88888888-8888-4888-8888-${index.toString(16).padStart(12, '0')}`)
}

function makeEntry(paneKey: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey,
    worktreeId,
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: []
  }
}

describe('selectWorktreeAgentOrchestration', () => {
  beforeEach(() => {
    releaseWorktreeAgentOrchestrationIndexCache()
  })

  it('rebuilds when a source it reads actually changes', () => {
    const context = { taskId: 't', dispatchId: 'd' }
    const paneKey = paneKeyFor('tab-1', 0)
    const base: IndexState = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      runtimeAgentOrchestrationByPaneKey: { [paneKey]: context },
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({}))
    }
    selectWorktreeAgentOrchestration(base, 'wt-1')

    const replacement = { taskId: 't2', dispatchId: 'd2' }
    const replaced = {
      ...base,
      runtimeAgentOrchestrationByPaneKey: { [paneKey]: replacement }
    }
    expect(selectWorktreeAgentOrchestration(replaced, 'wt-1')[paneKey]).toBe(replacement)

    // Why: moving the tab to another worktree must re-attribute, which only
    // happens if tab membership is keyed on the tabs slice identity.
    const movedTab = {
      ...replaced,
      tabsByWorktree: { 'wt-2': [makeTab('tab-1')] }
    }
    expect(selectWorktreeAgentOrchestration(movedTab, 'wt-1')).toBe(
      EMPTY_WORKTREE_AGENT_ORCHESTRATION
    )
    expect(selectWorktreeAgentOrchestration(movedTab, 'wt-2')[paneKey]).toBe(replacement)
  })

  it('treats a __proto__ pane key as data instead of a prototype write', () => {
    // Treat __proto__ as data so the pane cannot replace the result’s prototype.
    const context = { taskId: 't', dispatchId: 'd' }
    const state: IndexState = {
      tabsByWorktree: {},
      runtimeAgentOrchestrationByPaneKey: Object.fromEntries([['__proto__', context]]),
      agentStatusByPaneKey: acceptedAgentStatuses([['__proto__', makeEntry('__proto__', 'wt-1')]])
    }

    const record = selectWorktreeAgentOrchestration(state, 'wt-1')
    expect(Object.keys(record)).toEqual(['__proto__'])
    expect(record['__proto__']).toBe(context)
    expect(Object.getPrototypeOf(record)).toBeNull()
  })
})
