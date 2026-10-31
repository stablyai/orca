import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { legacyLaunchTextUpdates } from './agent-launch-permission-updates'
import { composeAgentLaunchProfile, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'

describe('rich output environment ownership', () => {
  it.each(['linux', 'win32'] as const)(
    'does not make the switch sticky after an unrelated %s environment edit',
    (platform) => {
      const before = { claudeRichOutput: true, agentPermissionDefault: 'own' as const }
      const updates = agentLaunchSettingsMutationUpdates(
        before,
        { type: 'environment-set', agent: 'claude', name: 'PROJECT_MODE', value: 'test' },
        platform
      )
      const after = { ...before, ...updates, claudeRichOutput: false }
      expect(after.agentDefaultEnv?.claude).toEqual({ PROJECT_MODE: 'test' })
      expect(resolveTuiAgentLaunchEnv('claude', after, platform)).toEqual({ PROJECT_MODE: 'test' })
    }
  )

  it('does not persist the derived flag when removing an unrelated variable', () => {
    const before = {
      claudeRichOutput: true,
      agentPermissionDefault: 'own' as const,
      agentDefaultEnv: { claude: { PROJECT_MODE: 'test' } }
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'environment-remove', agent: 'claude', name: 'PROJECT_MODE' },
      'linux'
    )
    expect(
      resolveTuiAgentLaunchEnv('claude', { ...before, ...updates, claudeRichOutput: false })
    ).toEqual({})
  })

  it.each([true, false])(
    'drops a legacy echoed flag even when the current switch is %s',
    (enabled) => {
      const before = {
        claudeRichOutput: true,
        agentPermissionDefault: 'own' as const,
        agentDefaultEnv: { claude: { ORIGINAL: 'kept' } }
      }
      const published = composeAgentLaunchProfile(before, 'linux')
      const current = { ...before, claudeRichOutput: enabled }
      const updates = legacyLaunchTextUpdates(
        current,
        {
          agentDefaultEnv: {
            ...published.agentDefaultEnv,
            claude: { ...published.agentDefaultEnv.claude, NEW: 'added' }
          }
        },
        'linux'
      )
      expect(
        resolveTuiAgentLaunchEnv('claude', { ...current, ...updates, claudeRichOutput: false })
      ).toEqual({ ORIGINAL: 'kept', NEW: 'added' })
    }
  )

  it.each(['0', '1'])(
    'preserves a deliberate %s override across edits and legacy round trips',
    (value) => {
      const before = { claudeRichOutput: true, agentPermissionDefault: 'own' as const }
      const explicit = agentLaunchSettingsMutationUpdates(
        before,
        {
          type: 'environment-set',
          agent: 'claude',
          name: 'ORCA_CLAUDE_RICH_OUTPUT',
          value
        },
        'linux'
      )
      const saved = { ...before, ...explicit }
      const published = composeAgentLaunchProfile(saved, 'linux')
      const updates = legacyLaunchTextUpdates(
        saved,
        { agentDefaultEnv: published.agentDefaultEnv },
        'linux'
      )
      const after = { ...saved, ...updates, claudeRichOutput: false }
      expect(resolveTuiAgentLaunchEnv('claude', after).ORCA_CLAUDE_RICH_OUTPUT).toBe(value)
      const removed = agentLaunchSettingsMutationUpdates(
        after,
        {
          type: 'environment-remove',
          agent: 'claude',
          name: 'ORCA_CLAUDE_RICH_OUTPUT'
        },
        'linux'
      )
      expect(resolveTuiAgentLaunchEnv('claude', { ...after, ...removed })).toEqual({})
    }
  )
})
