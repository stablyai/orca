import { describe, expect, it } from 'vitest'
import { toLinearProjectUpdateHealth } from './project-agent-writes'

describe('toLinearProjectUpdateHealth', () => {
  it('maps every CLI spelling to its API value', () => {
    expect(toLinearProjectUpdateHealth('on-track')).toBe('onTrack')
    expect(toLinearProjectUpdateHealth('at-risk')).toBe('atRisk')
    expect(toLinearProjectUpdateHealth('off-track')).toBe('offTrack')
  })

  // Why: a plain-object lookup reaches Object.prototype, so these used to answer with
  // a truthy function and pass as a real health value instead of being rejected.
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects the inherited key %s',
    (value) => {
      expect(toLinearProjectUpdateHealth(value)).toBeNull()
    }
  )

  it.each(['bogus', 'onTrack', 'ON-TRACK', ''])('rejects %j', (value) => {
    expect(toLinearProjectUpdateHealth(value)).toBeNull()
  })
})
