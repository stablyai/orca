import { describe, expect, it } from 'vitest'
import { botWslSetupStepStates, laterBotWslSetupStage } from './bot-wsl-setup-steps'

describe('botWslSetupStepStates', () => {
  it('marks the steps before the reported stage done', () => {
    expect(botWslSetupStepStates('connecting').map(({ state }) => state)).toEqual([
      'done',
      'done',
      'active',
      'pending'
    ])
  })

  it('reads no stage (an older main) as the first step', () => {
    expect(botWslSetupStepStates(null).map(({ state }) => state)).toEqual([
      'active',
      'pending',
      'pending',
      'pending'
    ])
  })

  it('never moves back when a late message names an earlier stage', () => {
    expect(laterBotWslSetupStage('connecting', 'installing-server')).toBe('connecting')
    expect(laterBotWslSetupStage('connecting', undefined)).toBe('connecting')
    expect(laterBotWslSetupStage('starting-distro', 'installing-server')).toBe('installing-server')
  })
})
