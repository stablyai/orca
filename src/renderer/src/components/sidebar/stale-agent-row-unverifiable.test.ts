/**
 * A stale agent entry on a pane Orca STILL HOLDS A LIVE PTY FOR is not the same thing as a
 * pane with nothing running in it. Both used to decay to `idle`, which asserts "nothing here"
 * on no evidence at all — the exact substitution docs/reference/ssh-execution-boundary.md
 * exists to prevent (loss of contact is never evidence).
 *
 * The split is on evidence Orca already computes: `tabHasLivePty`. With a live PTY the row
 * reads `unverifiable` and reports the observer's own fact — how long the silence has run —
 * so the user can apply knowledge Orca does not have. With no PTY it stays `idle`.
 *
 * Negative controls are the point of this suite: nothing may claim a pane FINISHED because
 * contact was lost, a fresh pane must still read `working`, and a pane with no agent must
 * still read `idle`.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makeTab } from '../../store/slices/store-test-helpers'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { getAgentDotState } from './worktree-card-agent-summary'
import { getCompactAgentSecondary } from './worktree-card-compact-agent-row'
import { resolveAttention } from './smart-attention'

const NOW = new Date('2026-05-04T12:00:00.000Z').getTime()
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
/** 34 minutes of silence: past the 30-minute window, and a legible elapsed reading. */
const SILENT_FOR_MS = 34 * 60 * 1000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const observedAt = NOW - SILENT_FOR_MS
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'run the long build',
    updatedAt: observedAt,
    stateStartedAt: observedAt,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function rowState(agentEntry: AgentStatusEntry, ptyIdsByTabId: Record<string, string[]>): string {
  const rows = buildWorktreeAgentRows({
    tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
    entries: [agentEntry],
    retained: [],
    ptyIdsByTabId,
    now: NOW
  })
  expect(rows).toHaveLength(1)
  return rows[0].state
}

const LIVE = { [TAB_ID]: ['pty-1'] }
const NO_PTY: Record<string, string[]> = {}

describe('a stale entry on a pane Orca still holds', () => {
  it('reads `unverifiable`, not `idle` — the reporting stream stopped, not the pane', () => {
    expect(rowState(entry(), LIVE)).toBe('unverifiable')
  })

  it('never claims the agent finished', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
      entries: [entry()],
      retained: [],
      ptyIdsByTabId: LIVE,
      now: NOW
    })
    expect(rows[0].state).not.toBe('done')
    expect(getAgentDotState(rows[0])).not.toBe('done')
    // Nor the working spinner: Orca has no current evidence of work either.
    expect(getAgentDotState(rows[0])).not.toBe('working')
    expect(getAgentDotState(rows[0])).toBe('unverifiable')
  })

  it('reports the observed gap rather than a verdict on the agent', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
      entries: [entry()],
      retained: [],
      ptyIdsByTabId: LIVE,
      now: NOW
    })
    expect(getCompactAgentSecondary(rows[0], NOW)).toBe('No update in 34m')
  })

  it('measures the gap from the observation clock, not the delivery clock', () => {
    // A relay replay restamps `updatedAt`; the reading must not reset with it.
    const replayed = entry({ updatedAt: NOW, evidenceObservedAt: NOW - SILENT_FOR_MS })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
      entries: [replayed],
      retained: [],
      ptyIdsByTabId: LIVE,
      now: NOW
    })
    expect(rows[0].state).toBe('unverifiable')
    expect(getCompactAgentSecondary(rows[0], NOW)).toBe('No update in 34m')
  })
})

describe('negative controls', () => {
  it('a pane with no live PTY still reads `idle`', () => {
    expect(rowState(entry(), NO_PTY)).toBe('idle')
  })

  it('a live pane with fresh events still reads `working`', () => {
    expect(rowState(entry({ updatedAt: NOW, stateStartedAt: NOW }), LIVE)).toBe('working')
  })

  it('a `done` pane is unaffected, however long ago it finished', () => {
    expect(rowState(entry({ state: 'done' }), LIVE)).toBe('done')
    expect(rowState(entry({ state: 'done', interrupted: true }), LIVE)).toBe('done')
  })

  it('a row hydrated from disk with no live hook since stays `idle`', () => {
    // Its staleness is structural, not elapsed silence, so there is no gap to report.
    expect(rowState(entry({ restoredUnconfirmed: true }), LIVE)).toBe('idle')
  })
})

describe('smart-attention ordering', () => {
  const working = entry({ updatedAt: NOW, stateStartedAt: NOW })

  it('ranks an unverifiable pane below a reporting one', () => {
    const unverifiable = resolveAttention([{ kind: 'hook', entry: entry(), hasLivePty: true }], NOW)
    const reporting = resolveAttention([{ kind: 'hook', entry: working, hasLivePty: true }], NOW)
    expect(unverifiable.cls).toBeGreaterThan(reporting.cls)
  })

  it('ranks an unverifiable pane above a genuinely idle one', () => {
    const unverifiable = resolveAttention([{ kind: 'hook', entry: entry(), hasLivePty: true }], NOW)
    const idle = resolveAttention([{ kind: 'hook', entry: entry(), hasLivePty: false }], NOW)
    expect(unverifiable.cls).toBeLessThan(idle.cls)
    expect(resolveAttention([], NOW).cls).toBe(idle.cls)
  })

  it('orders unverifiable panes by how recently each was last heard from', () => {
    const quieter = resolveAttention(
      [
        {
          kind: 'hook',
          entry: entry({ updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS * 4 }),
          hasLivePty: true
        }
      ],
      NOW
    )
    const louder = resolveAttention([{ kind: 'hook', entry: entry(), hasLivePty: true }], NOW)
    expect(louder.attentionTimestamp).toBeGreaterThan(quieter.attentionTimestamp)
  })
})
