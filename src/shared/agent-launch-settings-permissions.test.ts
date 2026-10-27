import { expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { structuredLaunchSeedOptions } from './native-chat-session-option-defaults'

it.each([
  ['yolo', 'full-access'],
  ['manual', 'own'],
  ['auto', 'auto']
] as const)(
  'legacy %s permission updates feed the single choice and new chats',
  (mode, expected) => {
    const before = {
      agentPermissionDefault: 'full-access' as const,
      nativeChatPermissionMode: 'accept-edits' as const
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', mode },
      'linux'
    )
    const after = { ...before, ...updates }
    expect(after.nativeChatPermissionMode).toBe('accept-edits')
    for (const agent of ['claude', 'codex'] as const) {
      expect(structuredLaunchSeedOptions(after, agent)).toEqual({ permissionMode: expected })
    }
    expect(updates).not.toHaveProperty('agentNativeChatPermissionModes')
  }
)
