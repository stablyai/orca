import { expect, it } from 'vitest'
import { legacyLaunchTextUpdates } from './agent-launch-permission-updates'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import { resolveAgentPermission } from './tui-agent-permission-choice'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { structuredLaunchSeedOptions } from './native-chat/input/native-chat-session-option-defaults'

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

it.each(['record', 'arguments'] as const)(
  "keeps an older client's Kimi Full access intent through a %s write",
  (route) => {
    const before = {
      agentPermissionDefault: 'own' as const,
      agentLaunchChoices: {},
      agentDefaultArgs: { kimi: '' }
    }
    const updates =
      route === 'record'
        ? legacyLaunchTextUpdates(before, { agentDefaultArgs: { kimi: '--yolo' } }, 'linux')
        : agentLaunchSettingsMutationUpdates(
            before,
            { type: 'arguments', agent: 'kimi', value: '--yolo' },
            'linux'
          )
    const after = { ...before, ...updates }
    expect(resolveAgentPermission('kimi', after).choice).toBe('full-access')
    expect(after.agentDefaultArgs.kimi).toBe('')
    expect(resolveTuiAgentLaunchArgs('kimi', after)).toBe('--auto')
  }
)

it.each(['record', 'arguments'] as const)(
  'keeps unchanged explicit Kimi Arguments on an older-client %s write',
  (route) => {
    const before = {
      agentPermissionDefault: 'full-access' as const,
      agentPermissionOverrides: { kimi: 'own' as const },
      agentLaunchChoices: {},
      agentDefaultArgs: { kimi: '--yolo' }
    }
    const updates =
      route === 'record'
        ? legacyLaunchTextUpdates(
            before,
            {
              agentDefaultArgs: { kimi: '--yolo', claude: '--permission-mode default' }
            },
            'linux'
          )
        : agentLaunchSettingsMutationUpdates(
            before,
            {
              type: 'arguments',
              agent: 'kimi',
              value: '--yolo'
            },
            'linux'
          )
    const after = { ...before, ...updates }
    expect(resolveAgentPermission('kimi', after).choice).toBe('own')
    expect(after.agentDefaultArgs.kimi).toBe('--yolo')
    expect(resolveTuiAgentLaunchArgs('kimi', after)).toBe('--yolo')
  }
)
