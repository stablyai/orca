import { describe, expect, it } from 'vitest'
import { buildTitleDerivedAgentRows } from './worktree-title-derived-agent-rows'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// Kiro's TUI writes `kiro: <session | ~/cwd>` and never a state glyph, so the
// sidebar row has to come from the title alone — Kiro has no hook service.
const LEAF_ID = '3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row builder reads only `id` and `title` off a tab.
const TAB = { id: 'tab-1', title: 'kiro: ~/code/orca-mods' } as unknown as TerminalTab

function rowsFor(title: string, tab: TerminalTab = TAB) {
  return buildTitleDerivedAgentRows({
    tabs: [{ ...tab, title }],
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a single-leaf layout is the whole shape the builder walks here.
      'tab-1': {
        activeLeafId: LEAF_ID,
        root: { type: 'leaf', leafId: LEAF_ID }
      } as never
    },
    seenPaneKeys: new Set<string>(),
    now: 1_000
  })
}

describe('Kiro title-derived sidebar row', () => {
  it('produces a row carrying Kiro identity, not "unknown"', () => {
    const rows = rowsFor('kiro: ~/code/orca-mods')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agentType).toBe('kiro')
    expect(rows[0]?.entry.agentType).toBe('kiro')
  })

  it('reads idle rather than pinning a spinner, since the title carries no state', () => {
    expect(rowsFor('kiro: ~/code/orca-mods')[0]?.state).toBe('idle')
  })

  it('keeps Kiro ownership when the session text names another agent', () => {
    expect(rowsFor('kiro: port the codex usage fetcher')[0]?.agentType).toBe('kiro')
  })

  it('still builds no row for a plain shell title', () => {
    expect(rowsFor('juan@host ~/code/orca-mods %')).toHaveLength(0)
  })
})
