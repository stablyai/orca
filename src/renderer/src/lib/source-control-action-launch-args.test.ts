import { describe, expect, it } from 'vitest'
import { resolveSourceControlActionLaunchArgs } from './source-control-action-launch-args'

describe('resolveSourceControlActionLaunchArgs', () => {
  it('resolves a saved blank field to the agent default', () => {
    expect(resolveSourceControlActionLaunchArgs('gemini', '', undefined)).toBe('--yolo')
  })

  it('honors a configured empty default as an explicit opt-out', () => {
    expect(resolveSourceControlActionLaunchArgs('gemini', '', { gemini: '' })).toBe('')
  })

  it('keeps an explicit action argument', () => {
    expect(resolveSourceControlActionLaunchArgs('gemini', '--sandbox', undefined)).toBe('--sandbox')
  })

  // Why: a never-saved recipe must keep reaching the launcher's own fallback unchanged.
  it('passes an absent field through untouched', () => {
    expect(resolveSourceControlActionLaunchArgs('gemini', undefined, undefined)).toBeUndefined()
  })

  // Why: when the launcher picks the agent downstream, blank must arrive as absent so that
  // launcher's fallback resolves against the agent it actually chose.
  it('reports a blank field as absent when the agent is not known yet', () => {
    expect(resolveSourceControlActionLaunchArgs(null, '', { gemini: '--x' })).toBeUndefined()
  })
})
