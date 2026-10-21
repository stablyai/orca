import { expect, it } from 'vitest'
import {
  selectForegroundProcessCandidate,
  type ForegroundProcessCandidate
} from './foreground-process-selection'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

/** The pre-memo lineage walk, with a step cap standing in for its missing cycle guard. */
function referenceIsAncestorOrSelf(
  ancestorPid: number,
  descendant: ForegroundProcessCandidate,
  byPid: ReadonlyMap<number, ForegroundProcessCandidate>
): boolean {
  let currentPid = descendant.pid
  for (let steps = 0; steps <= byPid.size + 1; steps += 1) {
    if (currentPid === ancestorPid) {
      return true
    }
    const current = byPid.get(currentPid)
    if (!current) {
      return false
    }
    currentPid = current.ppid
  }
  // Only reachable on a ppid cycle, where the original spun forever.
  return false
}

function referenceSelect(
  candidates: readonly ForegroundProcessCandidate[],
  ancestryCandidates: readonly ForegroundProcessCandidate[] = candidates
): ForegroundProcessCandidate | null {
  const recognized = candidates.flatMap((candidate) => {
    const agent = recognizeAgentProcessFromCommandLine(candidate.command)
    return agent ? [{ candidate, agent }] : []
  })
  if (recognized.length === 0) {
    return null
  }
  const names = new Set(recognized.map((entry) => entry.agent.agent))
  if (names.size > 1) {
    const byPid = new Map(ancestryCandidates.map((candidate) => [candidate.pid, candidate]))
    const outer = [...recognized].sort(
      (left, right) => left.candidate.depth - right.candidate.depth
    )[0]
    if (
      !outer ||
      !recognized.every((entry) =>
        referenceIsAncestorOrSelf(outer.candidate.pid, entry.candidate, byPid)
      )
    ) {
      return null
    }
    return outer.candidate
  }
  const score = (candidate: ForegroundProcessCandidate): number =>
    (candidate.stat?.includes('+') ? 10_000 : 0) + candidate.depth
  return recognized.reduce((best, current) =>
    score(current.candidate) > score(best.candidate) ? current : best
  ).candidate
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const COMMANDS = ['claude', 'codex', 'opencode', 'bash -lc build', 'node server.js']

/** A random process table: some rows reparented, some parents missing, some cycles. */
function makeTable(random: () => number, size: number): ForegroundProcessCandidate[] {
  const rows: ForegroundProcessCandidate[] = []
  for (let index = 0; index < size; index += 1) {
    const pid = index + 1
    const roll = random()
    let ppid: number
    if (index === 0) {
      ppid = 0
    } else if (roll < 0.15) {
      ppid = 9000 + index // parent absent from the table
    } else if (roll < 0.25) {
      ppid = 1 + Math.floor(random() * size) // arbitrary reparent, may form a cycle
    } else {
      ppid = index // straight chain
    }
    rows.push({
      pid,
      ppid,
      depth: index,
      stat: random() < 0.5 ? 'S+' : 'S',
      command: COMMANDS[Math.floor(random() * COMMANDS.length)]!
    })
  }
  return rows
}

it('picks the same foreground agent as the unmemoized lineage walk', () => {
  let multiAgentCases = 0
  let selectedCases = 0
  for (let seed = 1; seed <= 3000; seed += 1) {
    const random = makeRandom(seed)
    const table = makeTable(random, 1 + Math.floor(random() * 10))
    // Also exercise the split candidate/ancestry inputs the batch caller uses.
    const foreground = table.filter((_, index) => index % 3 !== 2)
    for (const [candidates, ancestry] of [
      [table, table],
      [foreground, table]
    ] as const) {
      const actual = selectForegroundProcessCandidate(candidates, ancestry)
      const expected = referenceSelect(candidates, ancestry)
      expect(actual?.candidate ?? null, `seed ${seed}`).toEqual(expected)
      if (
        new Set(candidates.map((row) => recognizeAgentProcessFromCommandLine(row.command)?.agent))
          .size > 2
      ) {
        multiAgentCases += 1
      }
      if (actual) {
        selectedCases += 1
      }
    }
  }
  // The mixed-agent ancestry branch (the only path the memo touches) must be hit.
  expect(multiAgentCases).toBeGreaterThan(500)
  expect(selectedCases).toBeGreaterThan(500)
})

// The pre-memo walk had no cycle guard, so a ppid loop that never reaches the outer
// agent spun forever and hung the caller reporting the foreground process.
it('terminates on a ppid cycle that never reaches the outer agent', () => {
  const cycle: ForegroundProcessCandidate[] = [
    { pid: 1, ppid: 0, depth: 0, stat: 'S+', command: 'claude' },
    { pid: 2, ppid: 3, depth: 1, stat: 'S+', command: 'codex' },
    { pid: 3, ppid: 2, depth: 2, stat: 'S+', command: 'bash -lc build' }
  ]
  expect(selectForegroundProcessCandidate(cycle)).toBeNull()
})

it('reflects a reparent, a spawn and an exit on the next capture', () => {
  const shell: ForegroundProcessCandidate = {
    pid: 10,
    ppid: 1,
    depth: 0,
    stat: 'S+',
    command: 'claude'
  }
  const helper: ForegroundProcessCandidate = {
    pid: 11,
    ppid: 10,
    depth: 1,
    stat: 'S+',
    command: 'codex'
  }
  // Nested lineage: the outer agent wins.
  expect(selectForegroundProcessCandidate([shell, helper])?.candidate.pid).toBe(10)

  // Reparent the helper to a pid outside the capture: the lineage no longer holds.
  const reparented = { ...helper, ppid: 999 }
  expect(selectForegroundProcessCandidate([shell, reparented])).toBeNull()

  // Spawn a sibling agent under an unrelated parent: still untrustworthy.
  const sibling: ForegroundProcessCandidate = {
    pid: 12,
    ppid: 1,
    depth: 1,
    stat: 'S+',
    command: 'opencode'
  }
  expect(selectForegroundProcessCandidate([shell, helper, sibling])).toBeNull()

  // The sibling exits: the surviving nested lineage resolves again on the new capture.
  expect(selectForegroundProcessCandidate([shell, helper])?.candidate.pid).toBe(10)
})
