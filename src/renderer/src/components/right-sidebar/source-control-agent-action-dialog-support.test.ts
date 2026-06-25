import { describe, expect, it } from 'vitest'
import {
  buildSourceControlAgentSaveTargets,
  getDefaultSourceControlAgentSaveTargetValue
} from './source-control-agent-action-dialog-support'

describe('source control agent action dialog save targets', () => {
  it('defaults saved launch recipes to the global target even when a repo target exists', () => {
    expect(buildSourceControlAgentSaveTargets('repo-1').map((target) => target.value)).toEqual([
      'none',
      'repo',
      'global'
    ])
    expect(getDefaultSourceControlAgentSaveTargetValue()).toBe('global')
  })
})
