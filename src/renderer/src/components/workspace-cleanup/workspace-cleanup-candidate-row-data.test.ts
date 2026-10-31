import { describe, expect, it } from 'vitest'
import { getCandidateFactStatuses } from './workspace-cleanup-candidate-row-data'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

describe('workspace cleanup candidate row data', () => {
  it('keeps unpushed risk visible for archived rows', () => {
    expect(
      getCandidateFactStatuses(
        makeCandidate({
          tier: 'review',
          reasons: ['archived'],
          git: {
            clean: true,
            upstreamAhead: 2,
            upstreamBehind: 0,
            checkedAt: 1
          }
        })
      )
    ).toContainEqual(expect.objectContaining({ label: 'Unpushed commits' }))
  })
})
