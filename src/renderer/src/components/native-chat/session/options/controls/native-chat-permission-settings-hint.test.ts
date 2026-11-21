import { describe, expect, it } from 'vitest'
import { nativeChatPermissionSettingsHint } from './native-chat-permission-settings-hint'

describe('the agent settings hint', () => {
  const own = { current: 'own', deferred: false }

  it('names only the settings while no mode is reported', () => {
    expect(nativeChatPermissionSettingsHint({ ...own, reported: undefined })).toBe('settings')
  })

  it('says a received mode Orca has no name for is not shown', () => {
    expect(nativeChatPermissionSettingsHint({ ...own, reported: 'read-only' })).toBe(
      'unnamed-report'
    )
  })

  it('adds nothing once the pill names a mode, Plan or a deferred pick', () => {
    for (const reported of ['ask', 'full-access', 'plan']) {
      expect(nativeChatPermissionSettingsHint({ ...own, reported })).toBeNull()
    }
    expect(
      nativeChatPermissionSettingsHint({ ...own, reported: undefined, deferred: true })
    ).toBeNull()
    expect(
      nativeChatPermissionSettingsHint({ current: 'ask', reported: undefined, deferred: false })
    ).toBeNull()
  })
})
