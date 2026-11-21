import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../agent-session-option-catalog'
import '../launch/agent-session-option-launch'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from '../../../native-chat/input/session-options/native-chat-session-option-defaults'
import { createNativeChatPtySessionOptions } from '../../../native-chat/input/session-options/native-chat-pty-session-options'
import { matchNativeChatCatalogModelId } from '../../../native-chat/input/session-options/native-chat-session-option-state'

describe('agent session option catalog', () => {
  it('parses Claude list_models discovery into catalog models with options', () => {
    const stdout = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orca-model-discovery',
        response: {
          models: [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'opus[1m]',
              displayName: 'Opus (1M context)',
              description: 'Opus 5 with 1M context',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'sonnet',
              displayName: 'Sonnet',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high']
            },
            { value: 'haiku', displayName: 'Haiku' }
          ]
        }
      }
    })
    const parsed = getAgentSessionOptionCatalog('claude')!.listModels!.parse(stdout)
    expect(parsed.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet', 'haiku'])
    expect(parsed[0]).toMatchObject({
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context'
    })
    expect(parsed[0].options.map(({ id }) => id)).toEqual(['effort', 'fastMode'])
    const opusEffort = parsed[0].options[0]
    expect(opusEffort.kind).toMatchObject({ defaultValue: 'high' })
    expect(
      opusEffort.kind.type === 'select' ? opusEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const sonnetEffort = parsed[1].options[0]
    expect(
      sonnetEffort.kind.type === 'select' ? sonnetEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high'])
    expect(parsed[2].options).toEqual([])
  })

  it('lists real provider routes in the primary picker, with unique names, and keeps the selected route', async () => {
    const stdout = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          models: [
            {
              value: 'claude-sonnet-5-5',
              displayName: 'Sonnet 5.5',
              description: 'Fast for routine tasks',
              resolvedModel: 'claude-sonnet-5-5'
            },
            {
              value: 'provider-a/claude-sonnet-5-5',
              displayName: 'Sonnet 5.5',
              description: 'Fast for routine tasks',
              resolvedModel: 'claude-sonnet-5-5'
            },
            {
              value: 'provider-b/claude-sonnet-5-5',
              displayName: 'Sonnet 5.5',
              description: 'Fast for routine tasks',
              resolvedModel: 'claude-sonnet-5-5'
            }
          ]
        }
      }
    })
    const catalog = getAgentSessionOptionCatalog('claude')
    const parsed = catalog?.listModels?.parse(stdout) ?? []
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'provider-routes',
      initialModels: parsed,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: async () => {}
    })
    if (!surface || !catalog) {
      throw new Error('claude catalog did not build a model picker')
    }
    await surface.setOption('model', 'provider-b/claude-sonnet-5-5')
    const model = surface.getSnapshot().find((entry) => entry.id === 'model')
    if (!model || model.kind.type !== 'select') {
      throw new Error('model picker missing')
    }
    const primary = model.kind.choices.filter((choice) => !choice.legacy)
    expect(primary.map((choice) => choice.value)).toEqual(
      expect.arrayContaining(['provider-a/claude-sonnet-5-5', 'provider-b/claude-sonnet-5-5'])
    )
    expect(new Set(model.kind.choices.map((choice) => choice.label)).size).toBe(
      model.kind.choices.length
    )
    const matched = matchNativeChatCatalogModelId(
      { ...catalog, models: parsed },
      'claude-sonnet-5-5',
      {
        selectedId: model.kind.currentValue
      }
    )
    expect(matched).toBe('provider-b/claude-sonnet-5-5')
    if (matched) {
      surface.reportSessionOptions({ model: matched })
    }
    const after = surface.getSnapshot().find((entry) => entry.id === 'model')
    expect(after?.kind.type === 'select' ? after.kind.currentValue : null).toBe(
      'provider-b/claude-sonnet-5-5'
    )
  })

  it('resolves only stored values without leaking values across models', () => {
    let persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'model',
      value: 'opus'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'effort',
      value: 'xhigh'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'sonnet',
      optionId: 'model',
      value: 'sonnet'
    })

    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'sonnet'
    })
    expect(persisted.claude?.valuesByModel?.opus).toEqual({ effort: 'xhigh' })
  })
})
