import { describe, expect, it } from 'vitest'
import { SettingsUpdate } from '../rpc-contract/client-ui/client-settings-params'
import { projectHostOwnedSettings } from './host-owned-settings'

// A strict settings.update rejects an unknown key, so the host-side Claude switch must be listed or a
// remote server silently refuses every write to it.
describe('host-owned Claude account-switch setting', () => {
  it('accepts each policy through the strict settings.update schema', () => {
    expect(SettingsUpdate.parse({ claudeAccountSwitchRunningSessions: 'keep' })).toEqual({
      claudeAccountSwitchRunningSessions: 'keep'
    })
    expect(SettingsUpdate.parse({ claudeAccountSwitchRunningSessions: 'ask' })).toEqual({
      claudeAccountSwitchRunningSessions: 'ask'
    })
  })

  it('rejects an unknown policy and stays strict for other keys', () => {
    expect(SettingsUpdate.safeParse({ claudeAccountSwitchRunningSessions: 'stop' }).success).toBe(
      false
    )
    expect(
      SettingsUpdate.safeParse({ claudeAccountSwitchRunningSessionsElsewhere: 'keep' }).success
    ).toBe(false)
  })

  it('projects the ask default so a client can tell the host accepts the key', () => {
    expect(projectHostOwnedSettings({}).claudeAccountSwitchRunningSessions).toBe('ask')
    expect(
      projectHostOwnedSettings({ claudeAccountSwitchRunningSessions: 'restart' })
        .claudeAccountSwitchRunningSessions
    ).toBe('restart')
  })
})
