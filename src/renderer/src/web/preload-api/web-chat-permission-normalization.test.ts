import { expect, it } from 'vitest'
import { runtimeChatPermissionSetting } from './web-preference-normalization'

it('clears a previous host scoped default when reading settings from a pre-native-sync host', () => {
  const cached = {
    nativeChatPermissionMode: 'full-access',
    agentNativeChatPermissionModes: { codex: 'auto' }
  }
  const current = {
    ...cached,
    ...runtimeChatPermissionSetting({ nativeChatPermissionMode: 'ask' })
  }
  expect(current).toEqual({ nativeChatPermissionMode: 'ask', agentNativeChatPermissionModes: {} })
})

it('never adds scoped overrides to the legacy settings.update strict schema', () => {
  expect(
    runtimeChatPermissionSetting(
      { nativeChatPermissionMode: 'ask', agentNativeChatPermissionModes: { codex: 'auto' } },
      false
    )
  ).toEqual({ nativeChatPermissionMode: 'ask' })
})
