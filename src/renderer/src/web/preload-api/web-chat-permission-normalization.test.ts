import { expect, it } from 'vitest'
import {
  migrateStoredWebSettings,
  runtimeChatPermissionSetting
} from './web-preference-normalization'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveAgentPermission } from '../../../../shared/tui-agent-permission-choice'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'

it.each([
  ['mixed', '--dangerously-skip-permissions --model sonnet', '--model sonnet', 'full-access'],
  ['explicit empty', '', '', 'own'],
  [
    'Claude plan',
    '--permission-mode plan --model sonnet',
    '--permission-mode plan --model sonnet',
    'own'
  ]
] as const)(
  'migrates saved browser %s Arguments once while retaining Chat',
  (_name, args, raw, choice) => {
    // Recorded Goose process environment: ticket 1447, PID 20979, creation validated around capture.
    const recordedGooseEnv = { GOOSE_MODE: 'auto', QA_GOOSE_NOTE: 'ordinary70a4' }
    const stored: Partial<GlobalSettings> & { agentNativeChatPermissionModes: unknown } = {
      agentDefaultArgs: { claude: args, codex: '' },
      agentDefaultEnv: { goose: recordedGooseEnv },
      nativeChatPermissionMode: 'ask',
      agentNativeChatPermissionModes: { claude: 'auto', codex: 'ask' }
    }
    const loaded = migrateStoredWebSettings(stored)
    expect(loaded.agentPermissionDefault).toBeDefined()
    expect(loaded.agentLaunchChoices).toBeUndefined()
    expect(resolveAgentPermission('claude', loaded).choice).toBe(choice)
    expect(resolveAgentPermission('codex', loaded).choice).toBe('own')
    expect(loaded.agentDefaultArgs?.claude).toBe(raw)
    expect(loaded.agentDefaultArgs?.codex).toBe('')
    expect(resolveTuiAgentLaunchArgs('claude', loaded)).toBe(args)
    expect(loaded.nativeChatPermissionMode).toBe('ask')
    expect(loaded).toHaveProperty(
      'agentNativeChatPermissionModes',
      stored.agentNativeChatPermissionModes
    )
    expect(resolveAgentPermission('goose', loaded).choice).toBe('full-access')
    expect(loaded.agentDefaultEnv?.goose).toEqual({ QA_GOOSE_NOTE: 'ordinary70a4' })
    expect(resolveTuiAgentLaunchEnv('goose', loaded)).toEqual(recordedGooseEnv)
    expect(migrateStoredWebSettings(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
  }
)

it('keeps the legacy host-support marker without recreating per-agent chat copies', () => {
  expect(runtimeChatPermissionSetting({ nativeChatPermissionMode: 'ask' })).toEqual({
    nativeChatPermissionMode: 'ask'
  })
  expect(runtimeChatPermissionSetting({})).toEqual({})
})
