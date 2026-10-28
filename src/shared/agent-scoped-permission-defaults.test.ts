import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { structuredLaunchSeedOptions } from './native-chat/input/native-chat-session-option-defaults'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import { AgentLaunchSettingsMutation } from './rpc-contract/agent-launch-settings-params'

const settings = {
  agentPermissionDefault: 'full-access' as const,
  nativeChatPermissionMode: 'ask' as const
}

describe('one permission for terminals and new chats', () => {
  it('uses a scoped legacy mutation for both surfaces without storing a chat copy', () => {
    const mutation = AgentLaunchSettingsMutation.parse({
      type: 'permissions',
      syncNativeChat: true,
      agent: 'codex',
      mode: 'auto'
    })
    const updates = agentLaunchSettingsMutationUpdates(settings, mutation, 'linux')
    const after = { ...settings, ...updates }
    expect(resolveTuiAgentLaunchArgs('codex', after)).toBe('--approve-for-me')
    expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'auto' })
    expect(structuredLaunchSeedOptions(after, 'claude')).toEqual({ permissionMode: 'full-access' })
    expect(updates).not.toHaveProperty('agentNativeChatPermissionModes')
    expect(updates).not.toHaveProperty('nativeChatPermissionMode')
  })

  it('own sends no terminal flag and seeds delegation without changing saved model options', () => {
    const after = {
      ...settings,
      ...agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permission', agent: 'codex', choice: 'own' },
        'linux'
      )
    }
    expect(resolveTuiAgentLaunchArgs('codex', after)).toBe('')
    expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'own' })
    expect(structuredLaunchSeedOptions(after, 'pi')).toBeUndefined()
    expect(after).not.toHaveProperty('nativeChatSessionOptions')
  })
})
