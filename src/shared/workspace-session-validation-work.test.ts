/* Deterministic guard for the validation work the session read boundary does. Counts zod container
 * nodes executed for one fixed payload rather than timing anything, so it cannot flake on a loaded
 * machine. It fails if the salvage combinators go back to letting zod validate-and-copy every map
 * and array before the transform re-walks it, or if the layout unions stop discriminating. */
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { parseWorkspaceSessionSalvaging } from './workspace-session-salvage'

let containerRuns = 0

// Why: zod's default memoizer is the only hook that sees every container node, so this file swaps
// it for a counting one. Cycle breaking is what it gives up, and no payload here holds a cycle.
z.config({
  memoizer: {
    alloc: (_inst: unknown, _payload: unknown, empty: unknown) => empty,
    guard: () => {},
    attach: (inst: {
      _zod: {
        deferred?: (() => void)[]
        parse: (payload: unknown, ctx: unknown) => unknown
        run: unknown
      }
    }) => {
      inst._zod.deferred ??= []
      inst._zod.deferred.push(() => {
        const base = inst._zod.parse
        const wrapped = (payload: unknown, ctx: unknown): unknown => {
          containerRuns += 1
          return base(payload, ctx)
        }
        inst._zod.parse = wrapped
        if (inst._zod.run === base) {
          inst._zod.run = wrapped
        }
      })
    }
  }
} as never)

const WORKTREES = 30
const TABS_PER_WORKTREE = 4

function worktreeId(index: number): string {
  return `repo-${index % 3}::/home/user/w${index}`
}

function terminalTab(id: string, wt: string, sortOrder: number): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId: wt,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1_700_000_000_000
  }
}

function unifiedTab(id: string, wt: string, sortOrder: number): Record<string, unknown> {
  return {
    id,
    entityId: id,
    groupId: `${wt}:group`,
    worktreeId: wt,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1_700_000_000_000
  }
}

/** Fixed shape, no randomness: the count below is only meaningful against a stable payload. */
function fixedSession(): Record<string, unknown> {
  const tabsByWorktree: Record<string, unknown> = {}
  const unifiedTabs: Record<string, unknown> = {}
  const tabGroups: Record<string, unknown> = {}
  const tabGroupLayouts: Record<string, unknown> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  const lastVisitedAtByWorktreeId: Record<string, unknown> = {}
  const terminalPtyIncarnationsByPaneKey: Record<string, unknown> = {}

  for (let w = 0; w < WORKTREES; w += 1) {
    const wt = worktreeId(w)
    const tabs: Record<string, unknown>[] = []
    const unified: Record<string, unknown>[] = []
    for (let t = 0; t < TABS_PER_WORKTREE; t += 1) {
      const id = `tab-${w}-${t}`
      tabs.push(terminalTab(id, wt, t))
      unified.push(unifiedTab(id, wt, t))
      terminalLayoutsByTabId[id] = {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: `${id}:a` },
          second: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: `${id}:b` },
            second: { type: 'leaf', leafId: `${id}:c` },
            ratio: 0.5
          }
        },
        activeLeafId: `${id}:a`,
        expandedLeafId: null,
        ptyIdsByLeafId: { [`${id}:a`]: `pty-${id}` },
        buffersByLeafId: { [`${id}:a`]: 'buffer' },
        scrollbackRefsByLeafId: { [`${id}:a`]: 'ref' },
        titlesByLeafId: { [`${id}:a`]: 'zsh' }
      }
      terminalPtyIncarnationsByPaneKey[`${id}:a`] = `inc-${id}`
    }
    tabsByWorktree[wt] = tabs
    unifiedTabs[wt] = unified
    tabGroups[wt] = [
      {
        id: `${wt}:group`,
        worktreeId: wt,
        activeTabId: `tab-${w}-0`,
        tabOrder: unified.map((tab) => tab.id as string)
      }
    ]
    tabGroupLayouts[wt] = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: `${wt}:group` },
      second: { type: 'leaf', groupId: `${wt}:group2` }
    }
    lastVisitedAtByWorktreeId[wt] = 1_700_000_000_000 + w
  }

  return {
    activeRepoId: 'repo-0',
    activeWorktreeId: worktreeId(0),
    activeTabId: 'tab-0-0',
    tabsByWorktree,
    terminalLayoutsByTabId,
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    lastVisitedAtByWorktreeId,
    terminalPtyIncarnationsByPaneKey
  }
}

/* Container-node executions for `fixedSession()`, measured on this branch:
 *   before this change: 1_958
 *   after this change:  1_111
 * The bound sits between the two, so it fails on any return to the pre-pass containers or to a
 * non-discriminated layout union, and tolerates ordinary schema growth. */
const MAX_CONTAINER_RUNS = 1_400

describe('workspace session validation work', () => {
  let parse: typeof parseWorkspaceSessionSalvaging

  beforeAll(async () => {
    parse = (await import('./workspace-session-salvage.js')).parseWorkspaceSessionSalvaging
  })

  it('validates the session without a redundant traversal of every map, array and union branch', () => {
    const payload = fixedSession()
    // Why: zod compiles object fast paths on first use, so measure a settled parse.
    parse(payload)
    containerRuns = 0
    const result = parse(payload)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedCount).toBe(0)
      expect(Object.keys(result.value.tabsByWorktree)).toHaveLength(WORKTREES)
    }
    expect(containerRuns).toBeGreaterThan(0)
    expect(containerRuns).toBeLessThanOrEqual(MAX_CONTAINER_RUNS)
  })
})
