import { describe, expect, it } from 'vitest'
import {
  selectForegroundProcessCandidate,
  type ForegroundProcessCandidate
} from './foreground-process-selection'

describe('selectForegroundProcessCandidate', () => {
  it('keeps a recognized ancestor over a different agent helper below a non-agent', () => {
    const candidates = [
      { pid: 101, ppid: 100, depth: 1, stat: 'S+', command: 'omp' },
      { pid: 102, ppid: 101, depth: 2, stat: 'S+', command: 'vendor-ui' },
      { pid: 103, ppid: 102, depth: 3, stat: 'S+', command: 'codex' }
    ]

    expect(selectForegroundProcessCandidate(candidates)).toMatchObject({
      candidate: { pid: 101 },
      recognized: { agent: 'omp' }
    })
  })

  it('traverses non-foreground helpers when checking ancestry', () => {
    const all = [
      { pid: 101, ppid: 100, depth: 1, stat: 'S+', command: 'omp' },
      { pid: 102, ppid: 101, depth: 2, stat: 'S', command: 'vendor-helper' },
      { pid: 103, ppid: 102, depth: 3, stat: 'S+', command: 'codex' }
    ]

    expect(selectForegroundProcessCandidate([all[0], all[2]], all)).toMatchObject({
      candidate: { pid: 101 },
      recognized: { agent: 'omp' }
    })
  })

  it('refuses different recognized agents on sibling lineages', () => {
    const candidates = [
      { pid: 101, ppid: 100, depth: 1, stat: 'S+', command: 'codex' },
      { pid: 102, ppid: 100, depth: 1, stat: 'S+', command: 'gemini' }
    ]

    expect(selectForegroundProcessCandidate(candidates)).toBeNull()
  })

  it.each([
    { helperStat: 'S+', selectedPid: 102 },
    { helperStat: 'S', selectedPid: 101 }
  ])('prefers foreground processes, then depth ($helperStat)', ({ helperStat, selectedPid }) => {
    const candidates = [
      { pid: 101, ppid: 100, depth: 1, stat: 'S+', command: 'node /opt/bin/codex' },
      { pid: 102, ppid: 101, depth: 2, stat: helperStat, command: '/opt/vendor/bin/codex' }
    ]

    expect(selectForegroundProcessCandidate(candidates)).toMatchObject({
      candidate: { pid: selectedPid },
      recognized: { agent: 'codex' }
    })
  })
})

it('memoizes shared ancestry while validating a long agent/helper lineage', () => {
  let reads = 0
  const candidates = Array.from({ length: 1000 }, (_, index) => ({
    pid: index + 1,
    get ppid() {
      reads += 1
      return index
    },
    depth: index,
    stat: 'S+',
    command: index % 2 === 0 ? 'omp' : 'codex'
  }))
  expect(selectForegroundProcessCandidate(candidates)?.candidate.pid).toBe(1)
  expect(reads).toBeLessThanOrEqual(1000)
})

it('terminates on a ppid cycle that never reaches the outer agent', () => {
  const cycle: ForegroundProcessCandidate[] = [
    { pid: 1, ppid: 0, depth: 0, stat: 'S+', command: 'claude' },
    { pid: 2, ppid: 3, depth: 1, stat: 'S+', command: 'codex' },
    { pid: 3, ppid: 2, depth: 2, stat: 'S+', command: 'bash -lc build' }
  ]
  expect(selectForegroundProcessCandidate(cycle)).toBeNull()
})

it('does not reuse ancestry after reparenting, spawning or exit', () => {
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
  expect(selectForegroundProcessCandidate([shell, helper])?.candidate.pid).toBe(10)

  const reparented = { ...helper, ppid: 999 }
  expect(selectForegroundProcessCandidate([shell, reparented])).toBeNull()

  const sibling: ForegroundProcessCandidate = {
    pid: 12,
    ppid: 1,
    depth: 1,
    stat: 'S+',
    command: 'opencode'
  }
  expect(selectForegroundProcessCandidate([shell, helper, sibling])).toBeNull()

  expect(selectForegroundProcessCandidate([shell, helper])?.candidate.pid).toBe(10)
})
