import { describe, it, expect } from 'vitest'
import { copyLaunchConfig } from '../../../../shared/agent-resume-record-from-status'
import { launchConfigsEqual } from '../../../../shared/agent-resume-record-equivalence'

describe('copyLaunchConfig and launchConfigsEqual', () => {
  it('copies and compares claudeAccountId', () => {
    const base = { agentArgs: '', agentEnv: {} }
    expect(copyLaunchConfig({ ...base, claudeAccountId: 'acct-1' }).claudeAccountId).toBe('acct-1')
    expect(copyLaunchConfig(base)).not.toHaveProperty('claudeAccountId')
    expect(
      launchConfigsEqual({ ...base, claudeAccountId: 'a' }, { ...base, claudeAccountId: 'b' })
    ).toBe(false)
    expect(
      launchConfigsEqual({ ...base, claudeAccountId: 'a' }, { ...base, claudeAccountId: 'a' })
    ).toBe(true)
  })
})
