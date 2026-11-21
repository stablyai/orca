import { describe, expect, it } from 'vitest'
import { pluginHookContributionSchema } from './plugin-hook-contribution'

describe('hook contribution launchKinds', () => {
  it('is accepted on agent.launch.before', () => {
    expect(
      pluginHookContributionSchema.safeParse({
        event: 'agent.launch.before',
        launchKinds: ['new', 'resume', 'restore']
      }).success
    ).toBe(true)
  })
})
