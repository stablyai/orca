import { expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { structuredLaunchSeedOptions } from '../../native-chat/input/native-chat-session-option-defaults'

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

it.each([false, true])(
  'refuses a bulk read-only setting for agents that cannot enforce it (withoutAuto: %s)',
  (withoutAuto) => {
    const before = { agentPermissionDefault: 'own' as const }
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permission', choice: 'read-only', ...(withoutAuto ? { withoutAuto: true } : {}) },
        'linux'
      )
    ).toThrow()
    expect(before).toEqual({ agentPermissionDefault: 'own' })
  }
)

it('keeps a read-only choice scoped to the capable agent', () => {
  const before = { agentPermissionDefault: 'own' as const }
  expect(
    agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permission', choice: 'read-only', agent: 'codex' },
      'linux'
    )
  ).toEqual({ agentPermissionOverrides: { codex: 'read-only' } })
  expect(() =>
    agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permission', choice: 'read-only', agent: 'claude' },
      'linux'
    )
  ).toThrow()
})
