import { describe, expect, it } from 'vitest'
import { documentedOrchestrationCommandPairs } from '../../../config/scripts/orchestration-guide-invocations'
import {
  createGuideCommandLedger,
  findGuideCoverageGaps,
  findStaleExcuses
} from './orchestration-guide-command-ledger'

/**
 * The drift gate's own gate. It runs in vitest, not Playwright, so an excuse that
 * outlives the guide line it excuses fails on every PR rather than only on the
 * ones routed to E2E.
 */
describe('orchestration guide command ledger', () => {
  it('reads a non-trivial command list out of the guide', () => {
    const documented = documentedOrchestrationCommandPairs()
    expect(documented.size).toBeGreaterThan(40)
    expect(documented).toContain('send --to')
    expect(documented).toContain('worker-start --spec')
  })

  it('records the verb and flags of an orchestration argv and ignores anything else', () => {
    const ledger = createGuideCommandLedger()
    ledger.record(['orchestration', 'send', '--to', 'term_a', '--subject', 'x', '--json'])
    ledger.record(['status', '--json'])
    expect([...ledger.executedPairs()].sort()).toEqual([
      'send --json',
      'send --subject',
      'send --to'
    ])
  })

  it('reports a documented command nobody executed and an executed command nobody documented', () => {
    const gaps = findGuideCoverageGaps(new Set(['run-create --objective', 'send --nonsense']))
    expect(gaps.unexecuted).toContain('send --to')
    expect(gaps.unexecuted).not.toContain('run-create --objective')
    expect(gaps.undocumented).toEqual(['send --nonsense'])
  })

  it('excuses only pairs the guide still documents', () => {
    expect(findStaleExcuses()).toEqual([])
  })
})
