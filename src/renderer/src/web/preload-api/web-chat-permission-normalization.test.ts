import { expect, it } from 'vitest'
import {
  mergeSettings,
  migrateStoredWebSettings,
  runtimeChatPermissionSetting
} from './web-preference-normalization'
import { getDefaultSettings } from '../../../../shared/constants'
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
    const stored: Partial<GlobalSettings> = {
      agentDefaultArgs: { claude: args, codex: '' },
      agentDefaultEnv: { goose: recordedGooseEnv },
      nativeChatPermissionMode: 'ask',
      agentNativeChatPermissionModes: { claude: 'auto', codex: 'ask' }
    }
    const loaded = migrateStoredWebSettings(stored)
    expect(loaded.agentPermissionDefault).toBeDefined()
    expect(resolveAgentPermission('claude', loaded).choice).toBe(choice)
    expect(resolveAgentPermission('codex', loaded).choice).toBe('own')
    expect(loaded.agentDefaultArgs?.claude).toBe(raw)
    expect(loaded.agentDefaultArgs?.codex).toBe('')
    expect(resolveTuiAgentLaunchArgs('claude', loaded)).toBe(args)
    expect(loaded.nativeChatPermissionMode).toBe('ask')
    expect(loaded.agentNativeChatPermissionModes).toEqual(stored.agentNativeChatPermissionModes)
    expect(resolveAgentPermission('goose', loaded).choice).toBe('full-access')
    expect(loaded.agentDefaultEnv?.goose).toEqual({ QA_GOOSE_NOTE: 'ordinary70a4' })
    expect(resolveTuiAgentLaunchEnv('goose', loaded)).toEqual(recordedGooseEnv)
    expect(migrateStoredWebSettings(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
  }
)

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

it('keeps an old typed browser profile on its own DSH settings before defaults merge', () => {
  const stored: Partial<GlobalSettings> = {
    agentPermissionDefault: 'full-access',
    agentPermissionOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {}
  }
  const loaded = mergeSettings(getDefaultSettings('~'), migrateStoredWebSettings(stored))

  expect(loaded.dshAgentPermissionMigrated).toBe(true)
  expect(loaded.agentPermissionOverrides?.dsh).toBe('own')
  expect(resolveAgentPermission('dsh', loaded).choice).toBe('own')
  expect(resolveTuiAgentLaunchEnv('dsh', loaded)).toEqual({})
  expect(migrateStoredWebSettings(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
})

it('leaves a fresh typed browser profile following the global full-access choice', () => {
  const loaded = mergeSettings(
    getDefaultSettings('~'),
    migrateStoredWebSettings({
      agentPermissionDefault: 'full-access',
      agentPermissionOverrides: {},
      dshAgentPermissionMigrated: true
    })
  )

  expect(resolveAgentPermission('dsh', loaded).choice).toBe('full-access')
  expect(resolveTuiAgentLaunchEnv('dsh', loaded)).toEqual({
    DSH_PERMISSION_MODE: 'danger-full-access'
  })
})

it('preserves an explicit DSH choice and custom env in a typed browser profile', () => {
  const loaded = mergeSettings(
    getDefaultSettings('~'),
    migrateStoredWebSettings({
      agentPermissionDefault: 'full-access',
      agentPermissionOverrides: { dsh: 'full-access' },
      agentDefaultEnv: { dsh: { DSH_TUI_THEME: 'dark' } }
    })
  )

  expect(resolveAgentPermission('dsh', loaded).choice).toBe('full-access')
  expect(resolveTuiAgentLaunchEnv('dsh', loaded)).toEqual({
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TUI_THEME: 'dark'
  })
})

it('matches the main loader for a migrated untyped profile that never stored DSH', () => {
  const loaded = mergeSettings(
    getDefaultSettings('~'),
    migrateStoredWebSettings({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  )

  expect(loaded.dshAgentPermissionMigrated).toBe(true)
  expect(resolveAgentPermission('dsh', loaded).choice).toBe('own')
  expect(resolveTuiAgentLaunchEnv('dsh', loaded)).toEqual({})
  expect(migrateStoredWebSettings(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
})
