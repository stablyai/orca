import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { adoptStrandedHostPartitionSession } from './workspace-session-stranded-partition-adoption'

const WT = 'repo-1::/home/me/wt'

function tab(id: string): TerminalTab {
  return { id, worktreeId: WT, title: id, createdAt: 1 } as unknown as TerminalTab
}

function session(tabsByWorktree: Record<string, TerminalTab[]>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree }
}

/**
 * Which partition's terminal row wins when `local` and `ssh:<targetId>` both name one workspace.
 *
 * This module had no test, and `persistedSessionForTarget` feeds its result straight into a
 * wholesale `replace-session` upload — so whichever row survives here becomes the host's entire
 * answer for that workspace, and every other client reads it.
 *
 * The asymmetry below is deliberate and load-bearing, not an oversight. `workspacesTheBaseOwns`
 * keys on `tabs.length > 0`, which makes the direction the module argues for (an empty base must
 * not block adoption) work, and makes its mirror image (an empty HOST row cannot retract a
 * populated base row) unreachable. Erring that way is the correct trade — a resurrected tab is one
 * the user closes again, while the other direction is what let `replace-session` delete the host's
 * copy (#12721) — but it is a trade, so it is pinned rather than left to be rediscovered.
 */
describe('stranded-partition adoption of terminal rows', () => {
  it('adopts the host partition row over an empty legacy local row', () => {
    const merged = adoptStrandedHostPartitionSession(
      session({ [WT]: [] }),
      session({ [WT]: [tab('t1'), tab('t2')] })
    )
    expect(merged.tabsByWorktree[WT].map((entry) => entry.id)).toEqual(['t1', 't2'])
  })

  it('adopts a workspace the host partition names and the base has never heard of', () => {
    const merged = adoptStrandedHostPartitionSession(session({}), session({ [WT]: [tab('t1')] }))
    expect(merged.tabsByWorktree[WT].map((entry) => entry.id)).toEqual(['t1'])
  })

  // The known trade, pinned as behaviour so changing it has to be a deliberate act. During the
  // upgrade window a pre-partition build's rows sit in `local` while this build writes the owning
  // `ssh:<targetId>` partition, so an emptied workspace's tombstone loses to the legacy row and the
  // publish re-offers tabs the user closed. Bounded: a clean quit's `api.set` clears the legacy row
  // (`api.patch` does not).
  //
  // Deliberately NOT "fixed" by letting the owning partition's empty row win. That trades a
  // recoverable resurrection — the user closes the tab again — for a possible deletion, which is
  // the direction this module's own header argues against at length and the one that let
  // `replace-session` delete the host's copy (#12721). If this ever does change, it needs the
  // tombstone to be distinguishable from "the host holds nothing", which `hostHasNothingFor`
  // currently cannot do.
  it('keeps the populated legacy row when the owning partition holds only a tombstone', () => {
    const merged = adoptStrandedHostPartitionSession(
      session({ [WT]: [tab('t1'), tab('t2')] }),
      session({ [WT]: [] })
    )
    expect(merged.tabsByWorktree[WT].map((entry) => entry.id)).toEqual(['t1', 't2'])
  })

  // The base row is empty here on purpose, and the first draft of this test got it wrong: written
  // with a POPULATED base row it passed, but for the wrong reason — a populated row makes the
  // workspace un-adoptable before the contested check is ever consulted, so mutating that check to
  // `if (true)` left the test green. An empty base row is what makes the workspace adoptable at
  // all, which is the only state where the contested check is load-bearing.
  //
  // Worth keeping as a warning, not just a fix: "the assertion holds" and "the assertion could have
  // failed" are different claims, and reading only the first is how a data-loss bug survives a
  // review. Mutate the specific guard before believing a guard is tested.
  it('never lets a host row replace an existing base row for a contested workspace id', () => {
    const merged = adoptStrandedHostPartitionSession(
      session({ [WT]: [] }),
      session({ [WT]: [tab('host-1')] }),
      { contestedSessionKeys: new Set([WT]) }
    )
    expect(merged.tabsByWorktree[WT]).toEqual([])
  })

  it('still gap-fills a contested workspace the base holds no row for at all', () => {
    const merged = adoptStrandedHostPartitionSession(
      session({}),
      session({ [WT]: [tab('host-1')] }),
      { contestedSessionKeys: new Set([WT]) }
    )
    expect(merged.tabsByWorktree[WT].map((entry) => entry.id)).toEqual(['host-1'])
  })

  it('returns the base untouched when there is no host partition at all', () => {
    const base = session({ [WT]: [tab('t1')] })
    expect(adoptStrandedHostPartitionSession(base, null)).toBe(base)
  })
})
