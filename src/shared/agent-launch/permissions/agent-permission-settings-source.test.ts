import { describe, expect, it } from 'vitest'
import { agentPermissionSettingsHint } from './agent-permission-settings-source'

describe('the agent settings hint', () => {
  const own = { current: 'own', deferred: false }

  it('promises a mode only while a report is still coming', () => {
    expect(agentPermissionSettingsHint({ ...own, reported: undefined, reportPending: true })).toBe(
      'report-pending'
    )
    expect(agentPermissionSettingsHint({ ...own, reported: undefined, reportPending: false })).toBe(
      'settings'
    )
    expect(agentPermissionSettingsHint({ ...own, reported: undefined })).toBe('settings')
  })

  it('says a reported mode Orca cannot name is not shown, even if a report was expected', () => {
    for (const reportPending of [true, false]) {
      expect(agentPermissionSettingsHint({ ...own, reported: 'read-only', reportPending })).toBe(
        'unnamed-report'
      )
    }
  })

  it('adds nothing once the pill names a mode, Plan or a deferred pick', () => {
    for (const reported of ['ask', 'full-access', 'plan']) {
      expect(agentPermissionSettingsHint({ ...own, reported, reportPending: true })).toBeNull()
    }
    expect(agentPermissionSettingsHint({ ...own, reported: undefined, deferred: true })).toBeNull()
    expect(
      agentPermissionSettingsHint({ current: 'ask', reported: undefined, deferred: false })
    ).toBeNull()
  })
})
