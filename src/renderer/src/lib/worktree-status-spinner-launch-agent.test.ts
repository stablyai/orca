import { describe, expect, it } from 'vitest'
import { buildTitleDerivedAgentRows } from '@/components/sidebar/worktree-title-derived-agent-rows'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { getWorktreeStatus } from './worktree-status'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

function singleLeafLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    titlesByLeafId: {}
  } as unknown as TerminalLayoutSnapshot
}

function rowCount(tab: Partial<TerminalTab>, paneTitles?: Record<number, string>): number {
  return buildTitleDerivedAgentRows({
    tabs: [{ id: 'tab-1', title: 'bash', ...tab } as TerminalTab],
    runtimePaneTitlesByTabId: paneTitles ? { 'tab-1': paneTitles } : {},
    ptyIdsByTabId: livePtyMap('tab-1'),
    terminalLayoutsByTabId: { 'tab-1': singleLeafLayout() },
    seenPaneKeys: new Set(),
    now: 0
  }).length
}

// Why: #9040 — Claude's thinking title is a braille spinner plus task text with no
// provider token, so the dot's attribution gate rejected it and the worktree resolved
// to 'active', which renders the same emerald dot as 'done'. The sidebar row builder
// already falls back to the tab's launch identity for spinner titles (#9647); the dot
// must agree.
describe('#9040 worktree dot attributes spinner titles to the launched agent', () => {
  it('spins for a Claude spinner title when the tab was launched as claude', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: '⠋ implementing the feature', launchAgent: 'claude' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('working')
  })

  it('spins for a spinner-only pane title when the tab was launched as claude', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'bash', launchAgent: 'claude' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: '⠙ refactoring the parser' } }
    )

    expect(status).toBe('working')
  })

  // Why: pins the #9647 gate — spinner attribution needs a launch identity, so a
  // spinner in a tab no agent was launched in cannot spin the dot.
  it('stays active for a spinner title with no launch identity', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('active')
  })

  it('does not manufacture activity from a non-spinner title with a launch identity', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'bash', launchAgent: 'claude' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('active')
  })
})

// Why: launchAgent usually clears on exit (clearTabLaunchAgent via
// resolveLaunchedAgentExitEvidence), but not on every path — a hookless remote agent has
// no completion hook and no shell-foreground producer, so its launch identity can outlive
// it and a later ora-style spinner then reads as working. Documented trade-off, not an
// oversight — the row builder has behaved this way since #9647. Pinned so it stays a
// deliberate choice rather than drifting silently.
describe('#9040 spinner attribution trade-off is bounded', () => {
  it('over-reports a non-agent spinner in a tab an agent was launched in', () => {
    const tab = {
      id: 'tab-1',
      title: '⠋ Progress: resolved 42',
      launchAgent: 'claude'
    } satisfies Partial<TerminalTab>

    expect(getWorktreeStatus([tab], [], livePtyMap('tab-1'))).toBe('working')
    // Bound 1: the same title cannot spin a tab with no launch identity.
    expect(getWorktreeStatus([{ id: 'tab-1', title: tab.title }], [], livePtyMap('tab-1'))).toBe(
      'active'
    )
    // Bound 2: a dead PTY drops out regardless of launch identity.
    expect(getWorktreeStatus([tab], [], {})).toBe('inactive')
  })
})

// Why: the gate's stated purpose is that the dot never spins with no matching sidebar
// row. Claude's spinner title must reach the same dot/row agreement a named provider
// already gets — no better, and no worse.
describe('#9040 spinner attribution matches named-provider dot/row agreement', () => {
  it('produces a sidebar row alongside the dot, like a named provider does', () => {
    const spinnerTab = {
      id: 'tab-1',
      title: '⠋ implementing the feature',
      launchAgent: 'claude'
    } satisfies Partial<TerminalTab>
    const namedTab = { id: 'tab-1', title: 'claude [working]' }

    expect(getWorktreeStatus([spinnerTab], [], livePtyMap('tab-1'))).toBe('working')
    expect(rowCount(spinnerTab)).toBe(1)
    // Control: the pre-existing named-provider path resolves to the same pair.
    expect(getWorktreeStatus([namedTab], [], livePtyMap('tab-1'))).toBe('working')
    expect(rowCount(namedTab)).toBe(1)
  })

  it('agrees for a spinner pane title too', () => {
    const tab = { id: 'tab-1', title: 'bash', launchAgent: 'claude' } satisfies Partial<TerminalTab>
    const paneTitles = { 'tab-1': { 0: '⠙ refactoring the parser' } }
    const layouts = { 'tab-1': singleLeafLayout() }

    expect(
      getWorktreeStatus([tab], [], livePtyMap('tab-1'), paneTitles, {
        terminalLayoutsByTabId: layouts
      })
    ).toBe('working')
    expect(rowCount(tab, paneTitles['tab-1'])).toBe(1)
  })
})
