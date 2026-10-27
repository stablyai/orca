import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceRowComparator,
  type WorkspaceSortBy
} from '../workspace-view/workspace-row-sort'
import {
  classifySortStampEvent,
  enterAgentPaneState,
  REST_PANE,
  type AgentPaneState,
  type SortStamps
} from './sort-stamps'
import { agentPhaseTransition, nextAgentPhase, type AgentPhase } from '../agent-transitions'
import { compareSmartStamps, recentStamp } from './stamp-order'

/** Replay the sort-stamps design table through the host classifier and shared client ordering. */
type Row = { id: string; stamps: SortStamps; pane: AgentPaneState; unread: boolean }

const T0 = 10_000_000

class Host {
  readonly rows = new Map<string, Row>()
  now = T0
  /** The workspace on screen: a finish there is seen, so it raises no unread flag. */
  openId: string | null = null

  constructor(ids: string[]) {
    // Older rows were touched earlier: b before a, c before b, ...
    ids.forEach((id, index) => {
      this.rows.set(id, {
        id,
        stamps: { recentAt: T0 - (index + 1) * 60_000 },
        pane: REST_PANE,
        unread: false
      })
    })
  }

  advance(ms: number): void {
    this.now += ms
  }

  agent(id: string, observed: AgentPhase): void {
    const row = this.rows.get(id)!
    const pane = enterAgentPaneState(row.pane, nextAgentPhase(row.pane.phase, observed), this.now)
    if (pane === row.pane) {
      return
    }
    this.apply(row, {
      kind: 'agent',
      from: row.pane.phase,
      to: pane.phase,
      transition: agentPhaseTransition(row.pane.phase, pane.phase),
      panes: [pane]
    })
    row.pane = pane
    if (pane.phase === 'done' && id !== this.openId) {
      row.unread = true
    }
  }

  /** Opening a workspace clears its unread flag, as the window does. */
  open(id: string): void {
    this.openId = id
    this.rows.get(id)!.unread = false
  }

  bell(id: string): void {
    this.apply(this.rows.get(id)!, { kind: 'bell' })
  }

  create(id: string): void {
    // Creation writes the first Recent stamp on the new record.
    this.rows.set(id, { id, stamps: { recentAt: this.now }, pane: REST_PANE, unread: false })
  }

  order(sortBy: WorkspaceSortBy): string[] {
    const compare = buildWorkspaceRowComparator<Row>(sortBy, {
      label: (row) => row.id,
      identity: (row) => row.id,
      repoLabel: () => '',
      recentActivity: (row) => recentStamp({ lastActivityAt: row.stamps.recentAt }),
      manualRank: () => null,
      compareSmart: (a, b) => compareSmartStamps(view(a), view(b))
    })
    return [...this.rows.values()].sort(compare).map((row) => row.id)
  }

  private apply(row: Row, event: Parameters<typeof classifySortStampEvent>[1]): void {
    row.stamps = classifySortStampEvent(row.stamps, event, this.now) ?? row.stamps
  }
}

function view(row: Row) {
  return {
    lastActivityAt: row.stamps.recentAt,
    smartTier: row.stamps.smartTier,
    smartAt: row.stamps.smartAt,
    isUnread: row.unread
  }
}

function both(host: Host): { recent: string[]; smart: string[] } {
  return { recent: host.order('recent'), smart: host.order('smart') }
}

describe('sort stamps: the design note’s before/after table', () => {
  it('an agent streaming output for minutes stays put', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('b', 'working')
    const before = both(host)
    // Output, tool calls and lease renewals are no events; only a finish would move it.
    for (let minute = 0; minute < 40; minute++) {
      host.advance(60_000)
      host.agent('b', 'working')
    }
    expect(both(host)).toEqual(before)
  })

  it('a finish tops Recent and Done at once; Done holds while unread, with no fade', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('a', 'working')
    host.advance(20_000)
    host.agent('c', 'working')
    host.advance(20_000)
    host.agent('c', 'done')
    expect(both(host)).toEqual({ recent: ['c', 'a', 'b'], smart: ['c', 'a', 'b'] })
    // No fade: an unread Done holds after any time without an event.
    host.advance(3 * 60 * 60_000)
    expect(host.order('smart')).toEqual(['c', 'a', 'b'])
  })

  it('opening the finished workspace ends Done; it rests by Recent (owner decision Q1)', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('a', 'working')
    host.advance(20_000)
    host.agent('c', 'working')
    host.advance(20_000)
    host.agent('c', 'done')
    host.open('c')
    // Working a now outranks c, which leads the rest by its Recent stamp.
    expect(both(host)).toEqual({ recent: ['c', 'a', 'b'], smart: ['a', 'c', 'b'] })
  })

  it('the next prompt ends Done: the row moves to Working', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('a', 'working')
    host.advance(20_000)
    host.agent('c', 'working')
    host.advance(20_000)
    host.agent('c', 'done')
    host.advance(20_000)
    host.agent('c', 'working')
    expect(host.rows.get('c')!.stamps.smartTier).toBe('working')
    expect(host.order('smart')).toEqual(['c', 'a', 'b'])
  })

  it('a finish in the open workspace is seen: top of Recent, never Done; opening never stamps', () => {
    const host = new Host(['a', 'b'])
    host.agent('a', 'working')
    host.open('b')
    // Opening b is not an event, so nothing changes until its agent finishes.
    expect(both(host)).toEqual({ recent: ['a', 'b'], smart: ['a', 'b'] })
    host.advance(20_000)
    host.agent('b', 'working')
    host.advance(20_000)
    host.agent('b', 'done')
    expect(both(host)).toEqual({ recent: ['b', 'a'], smart: ['a', 'b'] })
  })

  it('an agent asking for approval tops Needs you at once', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('a', 'working')
    host.agent('b', 'working')
    host.advance(20_000)
    host.agent('b', 'done')
    host.advance(20_000)
    host.agent('c', 'needs-you')
    expect(host.order('smart')).toEqual(['c', 'b', 'a'])
  })

  it('typing in a plain shell, renaming and editing a comment are not events', () => {
    // None reaches the classifier; worktrees-recent-stamp-switch-on.test.ts proves the window writes none.
    const host = new Host(['a', 'b', 'c'])
    const before = both(host)
    host.advance(60_000)
    expect(both(host)).toEqual(before)
  })

  it('sending a prompt tops Recent and moves the row to Working', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('c', 'working')
    expect(host.order('recent')[0]).toBe('c')
    expect(host.rows.get('c')!.stamps.smartTier).toBe('working')
  })

  it('a created workspace is on top until something newer happens', () => {
    const host = new Host(['a', 'b'])
    host.advance(1_000)
    host.create('new')
    expect(both(host).recent).toEqual(['new', 'a', 'b'])
    host.advance(11 * 60_000)
    expect(both(host).recent).toEqual(['new', 'a', 'b'])
    host.bell('b')
    expect(both(host).recent).toEqual(['b', 'new', 'a'])
  })

  it('two agents finishing a second apart: the newer is on top', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('a', 'working')
    host.agent('b', 'working')
    host.advance(20_000)
    host.agent('a', 'done')
    host.advance(1_000)
    host.agent('b', 'done')
    expect(both(host)).toEqual({ recent: ['b', 'a', 'c'], smart: ['b', 'a', 'c'] })
  })

  it('an SSH host disconnecting holds every row until a real event', () => {
    const host = new Host(['a', 'b'])
    host.agent('b', 'working')
    const before = both(host)
    // Loss of contact produces no event; time alone moves nothing.
    host.advance(2 * 60 * 60_000)
    expect(both(host)).toEqual(before)
  })

  it('a restart keeps the identical order: the stamps are on the records', () => {
    const host = new Host(['a', 'b', 'c'])
    host.agent('a', 'working')
    host.advance(20_000)
    host.agent('a', 'done')
    host.agent('c', 'needs-you')
    const before = both(host)
    const restarted = new Host([])
    for (const row of host.rows.values()) {
      restarted.rows.set(row.id, { ...row, pane: REST_PANE })
    }
    expect(both(restarted)).toEqual(before)
  })

  it('a resumed approval goes back to Working without topping Recent', () => {
    const host = new Host(['a', 'b'])
    host.agent('b', 'working')
    host.advance(20_000)
    host.agent('b', 'needs-you')
    host.advance(20_000)
    host.agent('a', 'working')
    host.advance(20_000)
    host.agent('b', 'working')
    expect(host.order('recent')).toEqual(['a', 'b'])
    expect(host.rows.get('b')!.stamps).toMatchObject({ smartTier: 'working' })
  })
})
