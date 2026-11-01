import { resolveAgentChoiceLayers } from './agent-choice-layers'
import { terminalSessionOptionInputs, resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'
import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'
import { AgentLaunchSettingsMutation } from './rpc-contract/agent-launch-settings-params'
import { migrateAgentPermissionChoice } from './tui-agent-permission-lift'
import { structuredLaunchSeedOptions } from './native-chat/input/native-chat-session-option-defaults'

const baseline: AgentLaunchSettingsSource = {
  agentPermissionDefault: 'ask',
  agentPermissionOverrides: {},
  agentDefaultArgs: { claude: '--verbose', codex: '--search' },
  agentLaunchChoices: {
    claude: { model: 'opus', options: { effort: 'high' } },
    codex: { model: 'opaque-id' }
  }
}
function mutate(
  settings: AgentLaunchSettingsSource,
  mutation: Parameters<typeof agentLaunchSettingsMutationUpdates>[1]
) {
  return { ...settings, ...agentLaunchSettingsMutationUpdates(settings, mutation, 'darwin') }
}

describe('host-authored launch defaults', () => {
  it('does not inspect raw text when no model or option can yield', () => {
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        argumentOwner: 'launch',
        defaults: { permissionMode: 'ask' },
        get userArgs(): string {
          throw new Error('Raw arguments are not needed for permission-only layers')
        }
      })
    ).toEqual({ permissionMode: 'ask' })
  })

  it('migrates typed-permission profiles once, preserves independent effort and initialized emptiness', () => {
    const loaded = migrateAgentPermissionChoice({
      agentPermissionDefault: 'ask',
      agentDefaultArgs: {
        claude: '--model retired-id --effort high --verbose',
        codex: '-c model_reasoning_effort=low --search'
      }
    })
    expect(loaded.agentLaunchChoices).toEqual({
      claude: { model: 'retired-id', options: { effort: 'high' } },
      codex: { options: { effort: 'low' } }
    })
    expect(loaded.agentDefaultArgs).toMatchObject({ claude: '--verbose', codex: '--search' })
    expect(migrateAgentPermissionChoice(loaded)).toEqual(loaded)
    expect(
      migrateAgentPermissionChoice({
        ...loaded,
        agentLaunchChoices: {},
        agentDefaultArgs: { claude: '--model literal' }
      }).agentDefaultArgs.claude
    ).toBe('--model literal')
  })

  it('applies option deltas to latest state and removes only matching dirty recipes atomically', () => {
    const settings = mutate(baseline, {
      type: 'launch-choices',
      agent: 'claude',
      patch: { options: { other: 'kept' } }
    })
    const cleared = mutate(settings, {
      type: 'launch-choices',
      agent: 'claude',
      patch: { options: { effort: null } },
      userArgs: '--effort low --verbose'
    })
    expect(cleared.agentLaunchChoices?.claude).toEqual({
      model: 'opus',
      options: { other: 'kept' }
    })
    expect(cleared.agentDefaultArgs?.claude).toBe('--effort low --verbose')
    const matched = mutate(settings, {
      type: 'launch-choices',
      agent: 'claude',
      patch: { options: { effort: null }, permissionMode: 'own' },
      userArgs: '--effort high --permission-mode default --verbose'
    })
    expect(matched.agentDefaultArgs?.claude).toBe('--verbose')
    expect(matched.agentPermissionOverrides?.claude).toBe('own')
    expect(matched.agentLaunchChoices?.claude?.options).toEqual({ other: 'kept' })
  })

  it('validates the additive mutation strictly without changing old mutation shapes', () => {
    const valid = {
      type: 'launch-choices',
      agent: 'codex',
      patch: { options: { effort: 'high' }, model: null }
    }
    expect(AgentLaunchSettingsMutation.safeParse(valid).success).toBe(true)
    for (const invalid of [
      { type: 'launch-choices', agent: 'codex' },
      { ...valid, patch: { extra: true } },
      { ...valid, patch: { options: { model: 'bad' } } },
      { ...valid, patch: { model: 'x'.repeat(513) } }
    ]) {
      expect(AgentLaunchSettingsMutation.safeParse(invalid).success).toBe(false)
    }
  })
})

it('uses original raw ownership before compiling authored terminal defaults', () => {
  const shell = 'posix' as const
  const settings = {
    agentPermissionDefault: 'own',
    agentDefaultArgs: { claude: '--verbose' },
    agentLaunchChoices: {
      claude: { model: 'opus', options: { effort: 'high', fastMode: 'true' } }
    }
  } as const
  const input = (
    agentArgs: string | undefined,
    sessionOptions?: Record<string, string>,
    yieldToAgentArgs?: boolean
  ) =>
    terminalSessionOptionInputs({
      agent: 'claude',
      settings,
      shell,
      agentArgs,
      sessionOptions,
      yieldToAgentArgs
    })
  const launch = (startup: ReturnType<typeof input>) => {
    const result = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: {},
      platform: 'linux',
      shell,
      ...startup
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    const parsed = tokenizeStartupCommand(result.command, shell)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    return parsed.tokens
  }
  expect(input(undefined).sessionOptions).toEqual({
    model: 'opus',
    effort: 'high',
    fastMode: 'true'
  })
  expect(launch(input(undefined))).toEqual([
    'claude',
    '--verbose',
    '--model',
    'opus',
    '--effort',
    'high',
    '--settings',
    '{"fastMode":true}'
  ])
  expect(input('--model alias').sessionOptions).toBeUndefined()
  expect(launch(input('--model alias'))).toEqual(['claude', '--model', 'alias'])
  expect(input('--effort low').sessionOptions).toEqual({ model: 'opus', fastMode: 'true' })
  expect(input(undefined, { model: 'sonnet' }, true).sessionOptions).toEqual({ model: 'sonnet' })
  expect(input('--model alias', { model: 'sonnet' }, true).sessionOptions).toBeUndefined()
  expect(input('--model alias', { model: 'sonnet', effort: 'low' }).sessionOptions).toEqual({
    model: 'sonnet',
    effort: 'low'
  })
  const raw = `--settings ${quoteStartupArg('{"language":"french","fastMode":false}', shell)}`
  // The existing token grammar, including file settings, owns the complete carrier.
  expect(input('--settings config.json').sessionOptions).toEqual({
    model: 'opus',
    effort: 'high'
  })
  expect(input(raw).sessionOptions).toEqual({ model: 'opus', effort: 'high' })
  expect(launch(input(raw))).toContain('{"language":"french","fastMode":false}')
})

it.each(['claude', 'codex'] as const)(
  'preserves encoded boolean seeds through authored/remembered layering for %s',
  (agent) => {
    const remembered = {
      model: 'remembered-model',
      valuesByModel: { 'remembered-model': { effort: 'low', fastMode: true } }
    }
    const settings = {
      agentPermissionDefault: 'ask' as const,
      nativeChatSessionOptions: { [agent]: remembered },
      agentLaunchChoices: {}
    }
    expect(structuredLaunchSeedOptions(settings, agent)).toMatchObject({
      model: 'remembered-model',
      effort: 'low',
      fastMode: 'true'
    })
    const authored = {
      ...settings,
      agentLaunchChoices: {
        [agent]: { model: 'authored-model', options: { effort: 'high', fastMode: 'false' } }
      }
    }
    expect(structuredLaunchSeedOptions(authored, agent)).toMatchObject({
      model: 'authored-model',
      effort: 'high',
      fastMode: 'false'
    })
    expect(
      structuredLaunchSeedOptions({ ...authored, agentLaunchChoices: {} }, agent)
    ).toMatchObject({ model: 'remembered-model', effort: 'low', fastMode: 'true' })
    expect(settings.nativeChatSessionOptions[agent]).toEqual(remembered)
    expect(
      structuredLaunchSeedOptions(
        {
          agentLaunchChoices: {
            [agent]: { options: { effort: 'high', fastMode: 'false' } }
          }
        },
        agent
      )
    ).toMatchObject({ effort: 'high', fastMode: 'false' })
  }
)
