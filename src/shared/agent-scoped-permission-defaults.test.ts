import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import {
  newChatPermissionModeForSettings,
  normalizeAgentNativeChatPermissionModes
} from './agent-chat-permission-mode'
import { structuredLaunchSeedOptions } from './native-chat-session-option-defaults'
import { AgentLaunchSettingsMutation } from './rpc-contract/agent-launch-settings-params'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'

const settings = {
  agentDefaultArgs: { ...YOLO_TUI_AGENT_ARGS },
  nativeChatPermissionMode: 'full-access' as const
}

describe('scoped agent permission defaults', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'changes only Codex terminal and future chats on %s',
    (platform) => {
      const updates = agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permissions', syncNativeChat: true, agent: 'codex', mode: 'auto' },
        platform
      )
      const after = { ...settings, ...updates }
      expect(after.agentDefaultArgs.codex).toBe('--approve-for-me')
      expect(after.agentDefaultArgs.claude).toBe(YOLO_TUI_AGENT_ARGS.claude)
      expect(after.agentDefaultArgs.gemini).toBe(YOLO_TUI_AGENT_ARGS.gemini)
      expect(updates).not.toHaveProperty('nativeChatPermissionMode')
      expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'auto' })
      expect(structuredLaunchSeedOptions(after, 'claude')).toEqual({
        permissionMode: 'full-access'
      })
      expect(structuredLaunchSeedOptions(after, 'omp')).toEqual({ permissionMode: 'full-access' })
    }
  )

  it('uses shipped launch defaults for an agent without a stored arguments key', () => {
    const updates = agentLaunchSettingsMutationUpdates(
      { nativeChatPermissionMode: 'ask' },
      { type: 'permissions', syncNativeChat: true, agent: 'codex', mode: 'auto' },
      'linux'
    )
    expect(updates.agentDefaultArgs).toEqual({ codex: '--approve-for-me' })
    expect(updates.agentNativeChatPermissionModes).toEqual({ codex: 'auto' })
  })

  it('can configure Claude independently without adopting a model', () => {
    const first = {
      ...settings,
      ...agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permissions', syncNativeChat: true, agent: 'codex', mode: 'auto' },
        'linux'
      )
    }
    const after = {
      ...first,
      ...agentLaunchSettingsMutationUpdates(
        first,
        { type: 'permissions', syncNativeChat: true, agent: 'claude', mode: 'manual' },
        'linux'
      )
    }
    expect(after.agentNativeChatPermissionModes).toEqual({ codex: 'auto', claude: 'ask' })
    expect(structuredLaunchSeedOptions(after, 'claude')).toEqual({ permissionMode: 'ask' })
    expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'auto' })
    expect(after).not.toHaveProperty('nativeChatSessionOptions')
  })

  it.each(['yolo', 'manual'] as const)('bulk %s resets scoped chat overrides', (mode) => {
    const before = { ...settings, agentNativeChatPermissionModes: { codex: 'auto' as const } }
    const after = {
      ...before,
      ...agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permissions', syncNativeChat: true, mode },
        'linux'
      )
    }
    expect(after.agentNativeChatPermissionModes).toEqual({})
    expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({
      permissionMode: mode === 'yolo' ? 'full-access' : 'ask'
    })
  })

  it.each(['manual', 'yolo'] as const)('changes only other agents with exceptAuto %s', (mode) => {
    const before = {
      ...settings,
      agentNativeChatPermissionModes: {
        claude: 'auto' as const,
        codex: 'ask' as const,
        grok: 'full-access' as const,
        opencode: 'full-access' as const
      }
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', mode, exceptAuto: true, syncNativeChat: true },
      'linux'
    )
    const after = { ...before, ...updates }
    expect(updates).not.toHaveProperty('nativeChatPermissionMode')
    expect(after.agentDefaultArgs.codex).toBe(settings.agentDefaultArgs.codex)
    expect(after.agentDefaultArgs.claude).toBe(settings.agentDefaultArgs.claude)
    expect(after.agentDefaultArgs.grok).toBe(
      mode === 'manual' ? '' : settings.agentDefaultArgs.grok
    )
    expect(after.agentNativeChatPermissionModes).toEqual({
      claude: 'auto',
      codex: 'ask',
      grok: mode === 'manual' ? 'ask' : 'full-access',
      antigravity: mode === 'manual' ? 'ask' : 'full-access',
      opencode: 'full-access'
    })
    expect(structuredLaunchSeedOptions(after, 'claude')).toEqual({ permissionMode: 'auto' })
    expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'ask' })
    expect(structuredLaunchSeedOptions(after, 'omp')).toEqual({ permissionMode: 'full-access' })
  })

  it('keeps Auto active when Other agents switches from Yolo to Manual', () => {
    const automatic = {
      ...settings,
      ...agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permissions', mode: 'auto', syncNativeChat: true },
        'linux'
      )
    }
    const after = {
      ...automatic,
      ...agentLaunchSettingsMutationUpdates(
        automatic,
        { type: 'permissions', mode: 'manual', exceptAuto: true, syncNativeChat: true },
        'linux'
      )
    }
    expect(after.agentDefaultArgs).toMatchObject({
      codex: '--approve-for-me',
      claude: '--permission-mode auto',
      grok: ''
    })
    expect(after.nativeChatPermissionMode).toBe('full-access')
    expect(structuredLaunchSeedOptions(after, 'codex')).toEqual({ permissionMode: 'auto' })
    expect(structuredLaunchSeedOptions(after, 'claude')).toEqual({ permissionMode: 'auto' })
    expect(structuredLaunchSeedOptions(after, 'grok')).toEqual({ permissionMode: 'ask' })
    expect(structuredLaunchSeedOptions(after, 'omp')).toEqual({ permissionMode: 'full-access' })
  })

  it('preserves custom Auto-capable terminal and native overrides under global Auto', () => {
    const before = {
      ...settings,
      agentDefaultArgs: { ...settings.agentDefaultArgs, claude: '--model custom' },
      agentNativeChatPermissionModes: { claude: 'accept-edits' as const, grok: 'ask' as const }
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', mode: 'auto', syncNativeChat: true },
      'linux'
    )
    expect(updates.agentDefaultArgs?.claude).toBe('--model custom')
    expect(updates.agentNativeChatPermissionModes).toEqual({
      claude: 'accept-edits',
      codex: 'auto',
      grok: 'ask'
    })
    expect(updates).not.toHaveProperty('nativeChatPermissionMode')
  })

  it('preserves custom other agents under exceptAuto and leaves legacy calls terminal-only', () => {
    const before = {
      ...settings,
      agentDefaultArgs: { ...settings.agentDefaultArgs, grok: '--model custom' },
      agentNativeChatPermissionModes: { claude: 'auto' as const, grok: 'full-access' as const }
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', mode: 'manual', exceptAuto: true, syncNativeChat: true },
      'linux'
    )
    expect(updates.agentDefaultArgs?.grok).toBe('--model custom')
    expect(updates.agentNativeChatPermissionModes?.grok).toBe('full-access')
    const legacy = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', mode: 'manual', exceptAuto: true },
      'linux'
    )
    expect(legacy).not.toHaveProperty('nativeChatPermissionMode')
    expect(legacy).not.toHaveProperty('agentNativeChatPermissionModes')
  })

  it('reapplies the same terminal choice to restore its scoped native default', () => {
    const before = {
      agentDefaultArgs: { codex: '--approve-for-me' },
      nativeChatPermissionMode: 'ask' as const
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'permissions', syncNativeChat: true, agent: 'codex', mode: 'auto' },
      'linux'
    )
    expect(updates.agentDefaultArgs?.codex).toBe('--approve-for-me')
    expect(structuredLaunchSeedOptions({ ...before, ...updates }, 'codex')).toEqual({
      permissionMode: 'auto'
    })
  })

  it('rejects custom arguments without losing options or changing native permissions', () => {
    const before = { ...settings, agentDefaultArgs: { codex: '--model custom --approve-for-me' } }
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permissions', syncNativeChat: true, agent: 'codex', mode: 'manual' },
        'linux'
      )
    ).toThrow('custom launch arguments')
    expect(before.agentDefaultArgs.codex).toBe('--model custom --approve-for-me')
    expect(before.nativeChatPermissionMode).toBe('full-access')
  })

  it('rejects scoped modes for agents without configurable terminal permissions', () => {
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permissions', syncNativeChat: true, agent: 'pi', mode: 'yolo' },
        'linux'
      )
    ).toThrow('no configurable')
  })

  it('refuses Auto for an agent without a reviewer', () => {
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permissions', syncNativeChat: true, agent: 'gemini', mode: 'auto' },
        'linux'
      )
    ).toThrow('does not support')
  })

  it('accepts both scoped and legacy permission wire mutations', () => {
    expect(
      AgentLaunchSettingsMutation.parse({
        type: 'permissions',
        syncNativeChat: true,
        agent: 'codex',
        mode: 'auto'
      })
    ).toEqual({ type: 'permissions', syncNativeChat: true, agent: 'codex', mode: 'auto' })
    expect(AgentLaunchSettingsMutation.parse({ type: 'permissions', mode: 'manual' })).toEqual({
      type: 'permissions',
      mode: 'manual'
    })
  })

  it.each([undefined, 'codex'] as const)(
    'keeps parent-client permissions terminal-only (agent %s)',
    (agent) => {
      const before = { ...settings, agentNativeChatPermissionModes: { claude: 'ask' as const } }
      const updates = agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permissions', mode: 'auto', ...(agent ? { agent } : {}) },
        'linux'
      )
      expect(updates).not.toHaveProperty('nativeChatPermissionMode')
      expect(updates).not.toHaveProperty('agentNativeChatPermissionModes')
      expect(structuredLaunchSeedOptions({ ...before, ...updates }, 'codex')).toEqual({
        permissionMode: 'full-access'
      })
    }
  )

  it('normalizes persisted overrides to only offered agent modes', () => {
    expect(
      normalizeAgentNativeChatPermissionModes({
        codex: 'auto',
        claude: 'accept-edits',
        omp: 'auto',
        mystery: 'full-access'
      })
    ).toEqual({ codex: 'auto', claude: 'accept-edits' })
    expect(
      newChatPermissionModeForSettings('codex', {
        nativeChatPermissionMode: 'full-access',
        agentNativeChatPermissionModes: { codex: 'ask' }
      })
    ).toBe('ask')
  })
})
