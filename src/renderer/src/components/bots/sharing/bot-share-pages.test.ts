import { describe, expect, it } from 'vitest'
import { pickedSkills } from './bot-share-pages'

const candidate = (packed: string[]) => ({
  bot: { skills: packed.map((name) => ({ name })) },
  available: { skills: [{ name: 'deploy' }, { name: 'electron', optInFrom: 'team-skills' }] }
})

describe('the Share dialog ticks', () => {
  const selection = { skills: ['deploy', 'electron'] }

  it('shows an outside skill unticked when the built candidate left it out', () => {
    expect(pickedSkills({ candidate: candidate(['deploy']), selection, committed: true })).toEqual([
      'deploy'
    ])
  })

  it('shows it ticked once the candidate carries it, or while one builds', () => {
    const packed = candidate(['deploy', 'electron'])
    expect(pickedSkills({ candidate: packed, selection, committed: true })).toEqual([
      'deploy',
      'electron'
    ])
    expect(pickedSkills({ candidate: candidate(['deploy']), selection, committed: false })).toEqual(
      ['deploy', 'electron']
    )
  })
})
