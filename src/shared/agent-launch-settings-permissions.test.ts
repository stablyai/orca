import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { structuredLaunchSeedOptions } from './native-chat-session-option-defaults'

describe('agent permission presets and new chats', () => {
  it.each([
    ['yolo', 'full-access'],
    ['manual', 'ask']
  ] as const)('uses %s as the terminal preset and %s as the new chat default', (mode, expected) => {
    const updates = agentLaunchSettingsMutationUpdates(
      { nativeChatPermissionMode: 'accept-edits' },
      { type: 'permissions', syncNativeChat: true, mode },
      'linux'
    )
    expect(updates.nativeChatPermissionMode).toBe(expected)
    for (const agent of ['claude', 'codex'] as const) {
      expect(structuredLaunchSeedOptions(updates, agent)).toEqual({ permissionMode: expected })
    }
  })

  it.each(['ask', 'full-access', 'accept-edits'] as const)(
    'preserves the %s shared default when enabling Auto',
    (nativeChatPermissionMode) => {
      const before = {
        nativeChatPermissionMode,
        agentNativeChatPermissionModes: { grok: 'ask' as const }
      }
      const updates = agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permissions', syncNativeChat: true, mode: 'auto' },
        'linux'
      )
      const after = { ...before, ...updates }
      expect(updates).not.toHaveProperty('nativeChatPermissionMode')
      expect(after.agentNativeChatPermissionModes).toEqual({
        grok: 'ask',
        claude: 'auto',
        codex: 'auto'
      })
      expect(structuredLaunchSeedOptions(after, 'claude')).toEqual({ permissionMode: 'auto' })
      expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'auto' })
      expect(structuredLaunchSeedOptions(after, 'grok')).toEqual({ permissionMode: 'ask' })
      expect(structuredLaunchSeedOptions(after, 'omp')).toEqual({
        permissionMode: nativeChatPermissionMode === 'full-access' ? 'full-access' : 'ask'
      })
      expect(structuredLaunchSeedOptions(after, 'pi')).toBeUndefined()
    }
  )

  it('keeps the separate chat default when editing terminal arguments', () => {
    const updates = agentLaunchSettingsMutationUpdates(
      { nativeChatPermissionMode: 'accept-edits' },
      { type: 'arguments', agent: 'claude', value: '--permission-mode auto' },
      'linux'
    )
    expect(updates.agentDefaultArgs?.claude).toBe('--permission-mode auto')
    expect(updates).not.toHaveProperty('nativeChatPermissionMode')
  })
})

it.each(['manual', 'yolo', 'auto'] as const)(
  'keeps legacy %s mutations terminal-only on native-capable hosts',
  (mode) => {
    const before = {
      nativeChatPermissionMode: 'accept-edits' as const,
      agentNativeChatPermissionModes: { codex: 'auto' as const }
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', mode },
      'linux'
    )
    expect(updates).not.toHaveProperty('nativeChatPermissionMode')
    expect(updates).not.toHaveProperty('agentNativeChatPermissionModes')
    expect({ ...before, ...updates }.nativeChatPermissionMode).toBe('accept-edits')
  }
)
