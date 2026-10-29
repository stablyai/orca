import { describe, expect, it } from 'vitest'
import { buildTitleDerivedAgentRows } from '@/components/sidebar/worktree-title-derived-agent-rows'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
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

// Accepted trade-off: hookless remote agents lack exit evidence, so retained launch identity can attribute a later unrelated spinner. Match the row builder’s deliberate #9647 behavior.
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

// Claude and named-provider titles must produce the same dot/sidebar agreement.
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
