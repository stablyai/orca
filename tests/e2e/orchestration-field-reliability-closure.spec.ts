import { expect, test } from '@playwright/test'
import { exerciseFieldReliabilityClosure } from './fixtures/orchestration-field-reliability-closure/closure-journey-fixture'

test('closes the frozen orchestration reliability fields', () => {
  const result = exerciseFieldReliabilityClosure()
  expect(result).toMatchObject({
    authority: { takeoverGeneration: 2, reboundHandle: 'term-coordinator-g3' },
    restartAndRebind: 3,
    effectiveProfile: { agent: 'codex', model: 'gpt-5', effort: 'high' },
    workerSettlement: { state: 'completed', completed: 1, total: 1 },
    projectionRefresh: [1, 2],
    nestedParent: 'provider-ofc',
    resourceKinds: expect.arrayContaining(['provider', 'browser', 'cleanup']),
    resourceParents: expect.arrayContaining([
      ['provider', 'dispatch-ofc'],
      ['provider', 'provider-ofc'],
      ['browser', 'dispatch-ofc'],
      ['terminal', 'attempt-ofc']
    ]),
    browser: { navigationOwned: true, disabledReason: 'Managed Browser surface is unavailable.' },
    redacted: [expect.stringContaining('[redacted]')],
    cleanup: { removed: true, rootAbsent: true }
  })
})
