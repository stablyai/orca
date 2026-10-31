import { describe, expect, it } from 'vitest'
import { getRunningProjectTransitions } from './running-project-transitions'

describe('getRunningProjectTransitions', () => {
  it('reports projects whose running state flipped, ignoring newly shown ones', () => {
    const previous = new Map([
      ['repo:a', true],
      ['repo:b', false],
      ['repo:c', true]
    ])
    const current = new Map([
      ['repo:a', false],
      ['repo:b', true],
      ['repo:c', true],
      ['repo:d', true]
    ])
    expect(getRunningProjectTransitions(previous, current)).toEqual({
      stopped: ['repo:a'],
      started: ['repo:b']
    })
  })
})
