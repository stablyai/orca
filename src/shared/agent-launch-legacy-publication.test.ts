import { expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'
import { legacyLaunchTextUpdates } from './agent-launch-permission-updates'
import { composeAgentLaunchProfile } from './tui-agent-launch-defaults'
import { structuredLaunchSeedOptions } from './native-chat/input/native-chat-session-option-defaults'
import { createGlobalSettingsFixture } from './global-settings-test-fixture'
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'

it('conserves canonical identity across both host-shell publications, edits and removals', () => {
  for (const [terminalWindowsShell, shell] of [
    ['powershell.exe', 'powershell'],
    ['cmd.exe', 'cmd'],
    ['git-bash', 'posix']
  ] as const) {
    for (const target of ['arguments', 'user-arguments'] as const) {
      let settings = createGlobalSettingsFixture({
        terminalWindowsShell,
        agentPermissionDefault: 'own',
        agentDefaultArgs: { claude: '--verbose', codex: '--search' },
        agentDefaultEnv: { claude: { KEEP: 'host' } },
        agentLaunchChoices: {
          claude: { model: String.raw`org\model`, options: { effort: 'high' } },
          codex: { model: 'gpt-5.6-sol' }
        },
        nativeChatSessionOptions: {
          claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'low' } } }
        }
      })
      const published = projectAgentLaunchSettings(settings, 'win32')
      const text =
        target === 'arguments'
          ? published.agentDefaultArgs.claude!
          : published.agentPermission!.userArgs.claude!
      expect(tokenizeStartupCommand(text, shell)).toMatchObject({
        ok: true,
        tokens: ['--model', String.raw`org\model`, '--effort', 'high', '--verbose']
      })
      expect(
        agentLaunchSettingsMutationUpdates(
          settings,
          { type: target, agent: 'claude', value: text },
          'win32'
        )
      ).toEqual({})
      const update = (value: string) => {
        const patch = agentLaunchSettingsMutationUpdates(
          settings,
          { type: target, agent: 'claude', value },
          'win32'
        )
        settings = { ...settings, ...patch }
      }
      update(`${text} --debug`)
      expect(settings.agentLaunchChoices?.claude).toEqual({
        model: String.raw`org\model`,
        options: { effort: 'high' }
      })
      expect(settings.agentDefaultArgs?.claude).toBe('--verbose --debug')
      expect(structuredLaunchSeedOptions(settings, 'claude')).toMatchObject({
        model: String.raw`org\model`,
        effort: 'high'
      })
      expect(
        tokenizeStartupCommand(
          composeAgentLaunchProfile(settings, 'win32').agentDefaultArgs.claude!,
          shell
        )
      ).toMatchObject({
        ok: true,
        tokens: ['--model', String.raw`org\model`, '--effort', 'high', '--verbose', '--debug']
      })
      update('--verbose --debug')
      expect(settings.agentLaunchChoices?.claude).toBeUndefined()
      expect(settings.agentLaunchChoices?.codex).toEqual({ model: 'gpt-5.6-sol' })
      expect(settings.agentDefaultEnv?.claude).toEqual({ KEEP: 'host' })
      expect(structuredLaunchSeedOptions(settings, 'claude')).toMatchObject({
        model: 'sonnet',
        effort: 'low'
      })
    }
  }
})

it('handles a whole-map legacy no-op, removed sibling and permission carrier in the same transaction', () => {
  const settings = createGlobalSettingsFixture({
    terminalWindowsShell: 'cmd.exe',
    agentPermissionDefault: 'ask',
    agentLaunchChoices: {
      claude: { model: 'org/model', options: { effort: 'high' } },
      codex: { model: 'gpt-5.6-sol' }
    },
    agentDefaultArgs: { claude: '--verbose', codex: '--search' }
  })
  const published = composeAgentLaunchProfile(settings, 'win32')
  const noop = legacyLaunchTextUpdates(
    settings,
    { agentDefaultArgs: published.agentDefaultArgs },
    'win32'
  )
  expect(noop).toEqual({})
  const changed = legacyLaunchTextUpdates(
    settings,
    {
      agentDefaultArgs: {
        ...published.agentDefaultArgs,
        claude: '--model org/model --effort high --verbose --debug',
        codex: ''
      }
    },
    'win32'
  )
  expect(changed.agentLaunchChoices?.claude).toEqual(settings.agentLaunchChoices?.claude)
  expect(changed.agentLaunchChoices?.codex).toBeUndefined()
  expect(changed.agentPermissionOverrides?.claude).toBe('own')
  expect(changed.agentDefaultArgs?.claude).toBe('--verbose --debug')
})

it('does not conserve generated ownership through duplicate, operand, terminator or changed model carriers', () => {
  const settings: AgentLaunchSettingsSource = {
    agentPermissionDefault: 'own',
    terminalWindowsShell: 'powershell.exe',
    agentLaunchChoices: { claude: { model: String.raw`org\model`, options: { effort: 'high' } } },
    agentDefaultArgs: { claude: '--verbose' }
  }
  const text = projectAgentLaunchSettings(settings, 'win32').agentDefaultArgs.claude!
  for (const value of [
    `${text} --model other`,
    `-- ${text}`,
    `--append-system-prompt ${text}`,
    '--model different --verbose'
  ]) {
    const update = agentLaunchSettingsMutationUpdates(
      settings,
      { type: 'arguments', agent: 'claude', value },
      'win32'
    )
    expect(update.agentLaunchChoices?.claude?.model).not.toBe(String.raw`org\model`)
  }
})

it('keeps native-only unrepresented choices and cuts Windows settings with their actual grammar', () => {
  const native: AgentLaunchSettingsSource = {
    agentPermissionDefault: 'own',
    agentLaunchChoices: { openclaw: { model: 'native-only' } },
    agentDefaultArgs: { openclaw: '' }
  }
  const changed = agentLaunchSettingsMutationUpdates(
    native,
    { type: 'arguments', agent: 'openclaw', value: '--debug' },
    'linux'
  )
  expect(changed.agentLaunchChoices?.openclaw).toEqual({ model: 'native-only' })
  const opaque = createGlobalSettingsFixture({
    terminalWindowsShell: 'cmd.exe',
    agentPermissionDefault: 'own',
    agentLaunchChoices: { claude: { model: 'sonnet', options: { fastMode: 'true' } } },
    agentDefaultArgs: { claude: '--settings ./user-settings.json --add-dir docs' }
  })
  const opaqueText = projectAgentLaunchSettings(opaque, 'win32').agentDefaultArgs.claude!
  const opaqueEdit = agentLaunchSettingsMutationUpdates(
    opaque,
    { type: 'arguments', agent: 'claude', value: `${opaqueText} --debug` },
    'win32'
  )
  expect(opaqueEdit.agentLaunchChoices?.claude).toEqual(opaque.agentLaunchChoices?.claude)
  expect(opaqueEdit.agentDefaultArgs?.claude).toBe(
    '--settings ./user-settings.json --add-dir docs --debug'
  )
  for (const [terminalWindowsShell, shell, fastMode] of [
    ['cmd.exe', 'cmd', 'true'],
    ['powershell.exe', 'powershell', 'false']
  ] as const) {
    const settings = createGlobalSettingsFixture({
      terminalWindowsShell,
      agentPermissionDefault: 'own',
      agentLaunchChoices: { claude: { model: 'sonnet', options: { fastMode } } },
      agentDefaultArgs: {
        claude: `--settings ${quoteStartupArg('{"theme":"light"}', shell)} --add-dir docs`
      },
      nativeChatSessionOptions: {
        claude: { model: 'sonnet', valuesByModel: { sonnet: { fastMode: fastMode !== 'true' } } }
      }
    })
    const publication = projectAgentLaunchSettings(settings, 'win32')
    for (const target of ['arguments', 'user-arguments'] as const) {
      const text =
        target === 'arguments'
          ? publication.agentDefaultArgs.claude!
          : publication.agentPermission!.userArgs.claude!
      expect(
        agentLaunchSettingsMutationUpdates(
          settings,
          { type: target, agent: 'claude', value: text },
          'win32'
        )
      ).toEqual({})
      const changed = agentLaunchSettingsMutationUpdates(
        settings,
        { type: target, agent: 'claude', value: `${text} --debug` },
        'win32'
      )
      expect(changed.agentLaunchChoices?.claude).toEqual(settings.agentLaunchChoices?.claude)
      expect(tokenizeStartupCommand(changed.agentDefaultArgs?.claude ?? '', shell)).toMatchObject({
        ok: true,
        tokens: ['--settings', '{"theme":"light"}', '--add-dir', 'docs', '--debug']
      })
      expect(structuredLaunchSeedOptions({ ...settings, ...changed }, 'claude')?.fastMode).toBe(
        fastMode
      )
      const sibling = agentLaunchSettingsMutationUpdates(
        settings,
        { type: target, agent: 'claude', value: `${text.replace('light', 'dark')} --debug` },
        'win32'
      )
      expect(sibling.agentLaunchChoices?.claude).toEqual(settings.agentLaunchChoices?.claude)
      expect(tokenizeStartupCommand(sibling.agentDefaultArgs?.claude ?? '', shell)).toMatchObject({
        ok: true,
        tokens: ['--settings', '{"theme":"dark"}', '--add-dir', 'docs', '--debug']
      })
      const stringValue = agentLaunchSettingsMutationUpdates(
        settings,
        {
          type: target,
          agent: 'claude',
          value: `--model sonnet --settings ${quoteStartupArg(`{"theme":"light","fastMode":"${fastMode}"}`, shell)} --debug`
        },
        'win32'
      )
      expect(stringValue.agentLaunchChoices?.claude).toEqual({ model: 'sonnet' })
      expect(
        tokenizeStartupCommand(stringValue.agentDefaultArgs?.claude ?? '', shell)
      ).toMatchObject({
        ok: true,
        tokens: ['--settings', `{"theme":"light","fastMode":"${fastMode}"}`, '--debug']
      })
      const removed = agentLaunchSettingsMutationUpdates(
        { ...settings, ...changed },
        {
          type: target,
          agent: 'claude',
          value: `--model sonnet --settings ${quoteStartupArg('{"theme":"dark"}', shell)} --add-dir docs --debug`
        },
        'win32'
      )
      expect(removed.agentLaunchChoices?.claude).toEqual({ model: 'sonnet' })
      expect(tokenizeStartupCommand(removed.agentDefaultArgs?.claude ?? '', shell)).toMatchObject({
        ok: true,
        tokens: ['--settings', '{"theme":"dark"}', '--add-dir', 'docs', '--debug']
      })
    }
  }
})

it('conserves the composed model tuple only while its actual carrier remains', () => {
  const flat: AgentLaunchSettingsSource = {
    agentPermissionDefault: 'own',
    agentLaunchChoices: { cursor: { model: 'gpt-5.3-codex', options: { fastMode: 'false' } } },
    agentDefaultArgs: { cursor: '--verbose' }
  }
  const flatText = projectAgentLaunchSettings(flat, 'linux').agentDefaultArgs.cursor!
  const flatEdit = agentLaunchSettingsMutationUpdates(
    flat,
    { type: 'arguments', agent: 'cursor', value: `${flatText} --debug` },
    'linux'
  )
  expect(flatEdit.agentLaunchChoices?.cursor).toEqual(flat.agentLaunchChoices?.cursor)
  expect(flatEdit.agentDefaultArgs?.cursor).toBe('--verbose --debug')
  const flatRemoved = agentLaunchSettingsMutationUpdates(
    { ...flat, ...flatEdit },
    { type: 'arguments', agent: 'cursor', value: '--verbose --debug' },
    'linux'
  )
  expect(flatRemoved.agentLaunchChoices?.cursor).toBeUndefined()
  expect(flatRemoved.agentDefaultArgs?.cursor).toBe('--verbose --debug')
  const unrepresented = agentLaunchSettingsMutationUpdates(
    flat,
    {
      type: 'launch-choices',
      agent: 'cursor',
      patch: { options: { fastMode: 'future-value' } }
    },
    'linux'
  )
  const future = { ...flat, ...unrepresented }
  expect(future.agentLaunchChoices?.cursor).toEqual({
    model: 'gpt-5.3-codex',
    options: { fastMode: 'future-value' }
  })
  const futureText = projectAgentLaunchSettings(future, 'linux').agentDefaultArgs.cursor!
  expect(futureText).toBe(flatText)
  const futureEdit = agentLaunchSettingsMutationUpdates(
    future,
    { type: 'arguments', agent: 'cursor', value: `${futureText} --debug` },
    'linux'
  )
  expect(futureEdit.agentLaunchChoices?.cursor).toEqual(future.agentLaunchChoices?.cursor)
  expect(futureEdit.agentDefaultArgs?.cursor).toBe('--verbose --debug')
  for (const modelArgs of ['', '--model auto ']) {
    const retired = agentLaunchSettingsMutationUpdates(
      { ...future, ...futureEdit },
      { type: 'arguments', agent: 'cursor', value: `${modelArgs}--verbose --debug` },
      'linux'
    )
    expect(retired.agentLaunchChoices?.cursor).toEqual(modelArgs ? { model: 'auto' } : undefined)
    expect(retired.agentDefaultArgs?.cursor).toBe('--verbose --debug')
  }
  const settings: AgentLaunchSettingsSource = {
    agentPermissionDefault: 'own',
    agentLaunchChoices: {
      cursor: { model: 'claude-opus-4-8', options: { thinking: 'true', effort: 'high' } }
    },
    agentDefaultArgs: { cursor: '--verbose' }
  }
  const text = projectAgentLaunchSettings(settings, 'linux').agentDefaultArgs.cursor!
  const changed = agentLaunchSettingsMutationUpdates(
    settings,
    { type: 'arguments', agent: 'cursor', value: `${text} --debug` },
    'linux'
  )
  expect(changed.agentLaunchChoices?.cursor).toEqual(settings.agentLaunchChoices?.cursor)
  expect(changed.agentDefaultArgs?.cursor).toBe('--verbose --debug')
  const removed = agentLaunchSettingsMutationUpdates(
    { ...settings, ...changed },
    { type: 'arguments', agent: 'cursor', value: '--model claude-opus-4-8 --verbose --debug' },
    'linux'
  )
  expect(removed.agentLaunchChoices?.cursor).toEqual({ model: 'claude-opus-4-8' })
})
