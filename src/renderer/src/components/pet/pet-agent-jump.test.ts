import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { selectPetAgentTarget } from './pet-agent-jump'

const NOW = 1_000
const STALE_AFTER_MS = 500

// Real paneKeys are `${tabId}:${uuid}` — parsePaneKey rejects a non-UUID leaf,
// so fixtures must use real ones or every case trivially returns null.
const LEAF_1 = 'ed140e4c-337a-4ac6-b034-7bcb9cdccca7'
const LEAF_A = 'aa140e4c-337a-4ac6-b034-7bcb9cdccca7'
const LEAF_Z = 'zz140e4c-337a-4ac6-b034-7bcb9cdccca7'

function entry(
  state: AgentStatusState,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: `tab-1:${LEAF_1}`,
    worktreeId: 'repo::/w',
    stateHistory: [],
    ...overrides
  }
}

describe('selectPetAgentTarget', () => {
  it('returns null when nothing fresh is happening', () => {
    expect(selectPetAgentTarget([], NOW, STALE_AFTER_MS)).toBeNull()
  })

  it('resolves the winning pane to a focusable target', () => {
    const target = selectPetAgentTarget(
      [entry('blocked', { agentType: 'omp' })],
      NOW,
      STALE_AFTER_MS
    )
    expect(target).toEqual({
      paneKey: `tab-1:${LEAF_1}`,
      agentType: 'omp',
      worktreeId: 'repo::/w'
    })
  })

  it('targets the SAME pane the bubble attributes, not merely the same agentType', () => {
    // Why this matters: two panes share the winning mood, so the ladder pins to
    // the lowest paneKey. If the target were recomputed by any other rule, the
    // menu would offer a jump to the pane the bubble is NOT talking about.
    const target = selectPetAgentTarget(
      [
        entry('waiting', {
          paneKey: `tab-z:${LEAF_Z}`,
          agentType: 'codex',
          worktreeId: 'repo::/z'
        }),
        entry('waiting', {
          paneKey: `tab-a:${LEAF_A}`,
          agentType: 'claude',
          worktreeId: 'repo::/a'
        })
      ],
      NOW,
      STALE_AFTER_MS
    )
    expect(target?.paneKey).toBe(`tab-a:${LEAF_A}`)
    expect(target?.worktreeId).toBe('repo::/a')
  })

  it('returns null for a stale winner so the menu cannot offer a dead jump', () => {
    const target = selectPetAgentTarget(
      [entry('working', { updatedAt: NOW - 5_000 })],
      NOW,
      STALE_AFTER_MS
    )
    expect(target).toBeNull()
  })

  it('returns null when the winning pane has no worktree attributed yet', () => {
    // Orchestration status can land before the renderer knows the pane's tab;
    // offering a jump then would focus nothing.
    const target = selectPetAgentTarget(
      [entry('blocked', { worktreeId: undefined })],
      NOW,
      STALE_AFTER_MS
    )
    expect(target).toBeNull()
  })

  it('returns null when the paneKey is unparseable', () => {
    const target = selectPetAgentTarget(
      [entry('blocked', { paneKey: 'no-separator' })],
      NOW,
      STALE_AFTER_MS
    )
    expect(target).toBeNull()
  })
})
