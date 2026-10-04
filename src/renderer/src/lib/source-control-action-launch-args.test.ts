import { describe, expect, it } from 'vitest'
import { sourceControlActionLaunchArgs } from './source-control-action-launch-args'

describe('sourceControlActionLaunchArgs', () => {
  // Why: the launchers resolve the agent's configured arguments only for `undefined`, so a blank
  // field has to arrive as absent rather than as an empty override.
  it('reports a blank field as absent', () => {
    expect(sourceControlActionLaunchArgs('')).toBeUndefined()
  })

  it('keeps an explicit action argument', () => {
    expect(sourceControlActionLaunchArgs('--sandbox')).toBe('--sandbox')
  })

  it('passes an unset field through untouched', () => {
    expect(sourceControlActionLaunchArgs(undefined)).toBeUndefined()
  })
})
