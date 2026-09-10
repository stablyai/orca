import { describe, expect, it } from 'vitest'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import { getRetainedFallbackTab } from '@/store/slices/agent-status-pane-key-tab-binding'
import { tabFromWorktreeAttributedStatusEntry } from './worktree-agent-row-fallback-tab'

/** The sidebar row a structured chat gets: no TerminalTab exists, so one is synthesized. */
function structuredRowName(name: string, agentType: 'codex' | 'claude' = 'codex'): string | null {
  const entry = {
    paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId('session-1'), 'session-1'),
    worktreeId: 'wt-1',
    terminalTitle: name,
    conversationName: name,
    stateStartedAt: 0,
    stateHistory: []
  } as unknown as AgentStatusEntry
  const tab = tabFromWorktreeAttributedStatusEntry(entry, 0)
  return tab && getAgentRowConversationName(tab, agentType, false)
}

describe('structured chat names in the sidebar row', () => {
  // Every one of these trips a predicate in the live-title sanitizer, which
  // exists to launder OSC titles scraped off a pty. A conversation name is a
  // deliberate value from a known-good source and must not go through it.
  it.each([
    ['a slashed feature-branch name', 'auth/login', 'codex'],
    ['a slashed path-like name a model would generate', 'src/renderer', 'codex'],
    ['a name that reads as a status word', 'done', 'codex'],
    // Matched against its OWN agent type, or the identity predicate never fires.
    ['a name that matches the agent identity', 'Claude', 'claude'],
    ['a name that looks like a default terminal title', 'Terminal 4', 'codex']
  ] as const)('keeps %s', (_label, name, agentType) => {
    expect(structuredRowName(name, agentType)).toBe(name)
  })

  it('keeps an ordinary name too', () => {
    expect(structuredRowName('Fix flaky retry test')).toBe('Fix flaky retry test')
  })
})

/** The other synthesizer: the row a retained agent keeps after its tab is gone. */
function retainedRowName(name: string, agentType: 'codex' | 'claude' = 'codex'): string | null {
  const entry = {
    paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId('session-1'), 'session-1'),
    worktreeId: 'wt-1',
    terminalTitle: name,
    conversationName: name,
    stateStartedAt: 0,
    stateHistory: []
  } as unknown as AgentStatusEntry
  return getAgentRowConversationName(getRetainedFallbackTab(entry, 'wt-1'), agentType, false)
}

describe('structured chat names on a retained row', () => {
  it.each([
    ['a slashed feature-branch name', 'auth/login', 'codex'],
    ['a name that matches the agent identity', 'Claude', 'claude'],
    ['a name that looks like a default terminal title', 'Terminal 4', 'codex']
  ] as const)('keeps %s after the live tab is gone', (_label, name, agentType) => {
    expect(retainedRowName(name, agentType)).toBe(name)
  })
})

describe('a manual rename reaches the row by the same path', () => {
  it.each([
    ['a slashed rename', 'auth/login'],
    ['a rename that reads as a status word', 'done']
  ])('keeps %s', (_label, name) => {
    // The bridge resolves customLabel over the provider name before this point,
    // so a manual rename arrives here as the settled conversation name and must
    // survive the same predicates.
    expect(structuredRowName(name)).toBe(name)
  })
})
