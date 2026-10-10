import { describe, expect, it } from 'vitest'
import { parseGitPerformanceConfigResult } from './git-performance-config-wire'

describe('parseGitPerformanceConfigResult', () => {
  it('keeps known entries and drops keys a newer relay may add', () => {
    expect(
      parseGitPerformanceConfigResult({
        state: {
          orcaKeys: [
            { key: 'checkout.workers', value: '0' },
            { key: 'pack.future', value: 'x' }
          ],
          userKeys: ['core.fsmonitor', 'pack.future']
        },
        plan: [
          { key: 'checkout.workers', value: '0', action: 'set' },
          { key: 'core.fsmonitor', action: 'skip', reason: 'set-by-user' },
          { key: 'core.untrackedCache', action: 'skip', reason: 'a-future-reason' }
        ],
        futureField: true
      })
    ).toEqual({
      state: { orcaKeys: [{ key: 'checkout.workers', value: '0' }], userKeys: ['core.fsmonitor'] },
      plan: [
        { key: 'checkout.workers', value: '0', action: 'set' },
        { key: 'core.fsmonitor', action: 'skip', reason: 'set-by-user' }
      ]
    })
  })

  it('rejects a reply without a state', () => {
    expect(() => parseGitPerformanceConfigResult({ plan: [] })).toThrow()
  })
})
