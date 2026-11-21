import { describe, expect, it } from 'vitest'
import { agentPermissionSettingsHint } from './agent-permission-settings-source'

describe('the agent settings hint', () => {
  const own = { current: 'own', deferred: false }

  it('names only the settings while no mode is reported', () => {
    expect(agentPermissionSettingsHint({ ...own, reported: undefined })).toBe('settings')
  })

  it('says a reported mode Orca cannot name is not shown', () => {
    expect(agentPermissionSettingsHint({ ...own, reported: 'read-only' })).toBe('unnamed-report')
  })

  it('adds nothing once the pill names a mode, Plan or a deferred pick', () => {
    for (const reported of ['ask', 'full-access', 'plan']) {
      expect(agentPermissionSettingsHint({ ...own, reported })).toBeNull()
    }
    expect(agentPermissionSettingsHint({ ...own, reported: undefined, deferred: true })).toBeNull()
    expect(
      agentPermissionSettingsHint({ current: 'ask', reported: undefined, deferred: false })
    ).toBeNull()
  })
})
