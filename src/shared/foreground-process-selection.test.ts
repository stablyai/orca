import { describe, expect, it } from 'vitest'
import { selectForegroundProcessCandidate } from './foreground-process-selection'

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

  it('keeps the deepest process when one recognized agent owns the lineage', () => {
    const candidates = [
      { pid: 101, ppid: 100, depth: 1, stat: 'S+', command: 'node /opt/bin/codex' },
      { pid: 102, ppid: 101, depth: 2, stat: 'S+', command: '/opt/vendor/bin/codex' }
    ]

    expect(selectForegroundProcessCandidate(candidates)).toMatchObject({
      candidate: { pid: 102 },
      recognized: { agent: 'codex' }
    })
  })
})
