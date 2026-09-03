import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { getWorktreeStatus } from './worktree-status'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

// A real Claude Code busy title: spinner frame plus generated summary, naming Claude only by accident.
const CLAUDE_BUSY_TITLE = '◐ Orca automatic session title renaming'
const CLAUDE_BUSY_TITLE_NAMING_CLAUDE = '◐ Claude status missing from to-do workspaces'

function livePty(): Record<string, string[]> {
  return { 'tab-1': ['pty-0'] }
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    },
    activeLeafId: LEAF_A,
    titlesByLeafId: {}
  } as unknown as TerminalLayoutSnapshot
}

function singleLeafLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_A },
    activeLeafId: LEAF_A,
    titlesByLeafId: {}
  } as unknown as TerminalLayoutSnapshot
}

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id: 'tab-1', title: 'bash', ...overrides } as TerminalTab
}

// Why: neither the busy title nor the null `launchAgent` identifies a hand-started agent (#15776); the process table does.
describe('worktree dot attributes a title status to the pane process running the agent', () => {
  it('spins when the pane foreground process is an agent and the title never names one', () => {
    const status = getWorktreeStatus(
      [tab({ title: CLAUDE_BUSY_TITLE })],
      [],
      livePty(),
      undefined,
      {
        foregroundAgentPaneIdsByTabId: { 'tab-1': new Set([LEAF_A]) },
        terminalLayoutRootsByTabId: { 'tab-1': singleLeafLayout().root }
      }
    )

    expect(status).toBe('working')
  })

  it('spins for a pane title too', () => {
    const status = getWorktreeStatus(
      [tab()],
      [],
      livePty(),
      { 'tab-1': { 1: CLAUDE_BUSY_TITLE } },
      {
        foregroundAgentPaneIdsByTabId: { 'tab-1': new Set([LEAF_A]) },
        terminalLayoutRootsByTabId: { 'tab-1': singleLeafLayout().root }
      }
    )

    expect(status).toBe('working')
  })

  // Why: pins the #9647 gate — process evidence is a new identity source, not a licence for any spinner.
  it('stays active for the same title when no pane runs an agent process', () => {
    expect(getWorktreeStatus([tab({ title: CLAUDE_BUSY_TITLE })], [], livePty())).toBe('active')
  })

  it('spins without process evidence when the title happens to name the agent', () => {
    expect(
      getWorktreeStatus([tab({ title: CLAUDE_BUSY_TITLE_NAMING_CLAUDE })], [], livePty())
    ).toBe('working')
  })

  it('attributes per pane, so a sibling pane spinner is not covered by another pane process', () => {
    const status = getWorktreeStatus(
      [tab()],
      [],
      livePty(),
      { 'tab-1': { 2: CLAUDE_BUSY_TITLE } },
      {
        foregroundAgentPaneIdsByTabId: { 'tab-1': new Set([LEAF_A]) },
        terminalLayoutRootsByTabId: { 'tab-1': splitLayout().root }
      }
    )

    expect(status).toBe('active')
  })

  // Why: process evidence is keyed by leaf id, so a title arriving before the layout (SSH/replay) has nothing to match.
  it('attributes a lone pane title to a lone agent pane before the layout hydrates', () => {
    const status = getWorktreeStatus(
      [tab()],
      [],
      livePty(),
      { 'tab-1': { 1: CLAUDE_BUSY_TITLE } },
      {
        foregroundAgentPaneIdsByTabId: { 'tab-1': new Set([LEAF_A]) }
      }
    )

    expect(status).toBe('working')
  })

  it('does not guess when an unhydrated tab reports more than one pane title', () => {
    const status = getWorktreeStatus(
      [tab()],
      [],
      livePty(),
      { 'tab-1': { 1: CLAUDE_BUSY_TITLE, 2: CLAUDE_BUSY_TITLE } },
      { foregroundAgentPaneIdsByTabId: { 'tab-1': new Set([LEAF_A]) } }
    )

    expect(status).toBe('active')
  })

  it('still reports a dead PTY as inactive', () => {
    const status = getWorktreeStatus([tab({ title: CLAUDE_BUSY_TITLE })], [], {}, undefined, {
      foregroundAgentPaneIdsByTabId: { 'tab-1': new Set([LEAF_A]) },
      terminalLayoutRootsByTabId: { 'tab-1': singleLeafLayout().root }
    })

    expect(status).toBe('inactive')
  })
})
