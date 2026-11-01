import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { getWorkspaceCleanupHostIdentity as identity } from '../../../../shared/workspace-cleanup-host-identity'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { makeTab, makeLayout } from './store-test-helpers'
import { makeAgentEntry, makeUnifiedTab } from '@/components/worktree-jump-palette-test-fixtures'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup-candidate-enrichment'
import { getWorkspaceCleanupAgentEvidence } from './workspace-cleanup-agent-evidence'
import { WORKTREE_ID, makeCandidate, makeState } from './workspace-cleanup-slice-test-harness'

function paneKey(tabId: string): string {
  return makePaneKey(tabId, '11111111-1111-4111-8111-111111111111')
}

function agentStatus(paneKey: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return makeAgentEntry('unused', state, Date.now(), { paneKey, connectionId: null })
}

// A structured chat publishes status under its own surface id; its tab is not in tabsByWorktree.
function structuredChatStatus(state: AgentStatusEntry['state']): AgentStatusEntry {
  return { ...agentStatus(paneKey('chat-1'), state), worktreeId: WORKTREE_ID }
}

describe('workspace cleanup live-agent finder', () => {
  it.each([
    ['working', true],
    ['done', false]
  ] as const)('qualifies %s structured evidence and live children: %s', async (state, live) => {
    const entry = structuredChatStatus(state)
    const appState = makeState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })

    const candidates = (['local', 'runtime:host', 'ssh:other'] as const).map((executionHostId) =>
      makeCandidate({ executionHostId })
    )
    const evidence = () => getWorkspaceCleanupAgentEvidence(appState, candidates)
    expect([...evidence().keys()]).toEqual(live ? [identity('local', WORKTREE_ID)] : [])
    const [enriched] = await enrichWorkspaceCleanupCandidates([makeCandidate()], appState)
    expect(enriched.blockers.includes('live-agent')).toBe(live)
    appState.tabsByWorktree = {
      [WORKTREE_ID]: [makeTab({ id: 'chat-1', worktreeId: WORKTREE_ID, title: '⠋ Codex' })]
    }
    expect([...evidence().keys()]).toEqual(live ? [identity('local', WORKTREE_ID)] : [])
    entry.subagents = [{ id: 'child', state: 'working', startedAt: Date.now() }]
    appState.tabsByWorktree = {}
    if (!live) {
      const tab = makeUnifiedTab('chat-1', WORKTREE_ID, 'session-1', 'Codex Chat')
      appState.unifiedTabsByWorktree = { [WORKTREE_ID]: [{ ...tab, contentType: 'agent-session' }] }
    }
    expect([...evidence().keys()]).toEqual([identity('local', WORKTREE_ID)])
    appState.ptyIdsByTabId = { 'chat-1': ['pty-other', 'remote:host@@pty'] }
    const layout = makeLayout()
    layout.ptyIdsByLeafId = { [entry.paneKey.split(':')[1]]: 'remote:host@@pty' }
    appState.terminalLayoutsByTabId = { 'chat-1': layout }
    expect([...evidence().keys()]).toEqual([identity('runtime:host', WORKTREE_ID)])
    appState.terminalLayoutsByTabId = {}
    appState.agentStatusByPaneKey = { [entry.paneKey]: { ...entry, connectionId: undefined } }
    expect([...evidence().values()]).toEqual(['unknown', 'unknown', 'unknown'])
  })
})
