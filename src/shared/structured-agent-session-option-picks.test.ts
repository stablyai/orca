import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  applyNativeChatSessionOptionPicks,
  resolveStructuredLaunchSeedOptions,
  updateNativeChatSessionOptionDefaults
} from './native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks
} from './structured-agent-session-options'

function liveState(current: { model: string; effort?: string }) {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('codex'),
    CODEX_SESSION_OPTION_CATALOG,
    {
      models: [
        {
          id: 'account-model',
          label: 'Account Model',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'other-model',
          label: 'Other Model',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
          ]
        }
      ],
      current
    }
  )
}

function persist(
  picks: readonly { modelId: string; optionId: string; value: string }[]
): PersistedNativeChatSessionOptions {
  return applyNativeChatSessionOptionPicks({ persisted: undefined, agent: 'codex', picks })
}

describe('structuredAgentSessionOptionPicks', () => {
  it('pins the model an effort-only pick was chosen against', () => {
    const picks = structuredAgentSessionOptionPicks(liveState({ model: 'account-model' }), {
      effort: 'high'
    })
    expect(picks).toEqual([{ modelId: 'account-model', optionId: 'effort', value: 'high' }])
    // Without the model the launch resolves nothing at all, so the effort would be dead.
    expect(resolveStructuredLaunchSeedOptions(persist(picks), 'codex')).toEqual({
      model: 'account-model',
      effort: 'high'
    })
  })

  it('remembers the effort the provider reconciled, not the one in force before', () => {
    const state = liveState({ model: 'account-model', effort: 'high' })
    const picks = structuredAgentSessionOptionPicks(state, {
      model: 'other-model',
      effort: 'low'
    })
    expect(picks).toEqual([
      { modelId: 'other-model', optionId: 'model', value: 'other-model' },
      { modelId: 'other-model', optionId: 'effort', value: 'low' }
    ])
    expect(resolveStructuredLaunchSeedOptions(persist(picks), 'codex')).toEqual({
      model: 'other-model',
      effort: 'low'
    })
  })

  it('reads the committed model rather than the record a deferred commit has not settled', () => {
    // The caller passes pre-commit state: the record still tracks the old model.
    const state = liveState({ model: 'account-model', effort: 'medium' })
    expect(structuredAgentSessionOptionPicks(state, { model: 'other-model' })).toEqual([
      { modelId: 'other-model', optionId: 'model', value: 'other-model' }
    ])
  })

  it('keeps a per-model effort so reselecting the old model restores its level', () => {
    const persisted = persist([
      ...structuredAgentSessionOptionPicks(liveState({ model: 'account-model' }), {
        effort: 'high'
      }),
      ...structuredAgentSessionOptionPicks(liveState({ model: 'account-model', effort: 'high' }), {
        model: 'other-model',
        effort: 'low'
      })
    ])
    const reselected = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'codex',
      modelId: 'account-model',
      optionId: 'model',
      value: 'account-model'
    })
    expect(resolveStructuredLaunchSeedOptions(reselected, 'codex')).toEqual({
      model: 'account-model',
      effort: 'high'
    })
  })

  it('writes nothing before the provider catalog lands', () => {
    expect(
      structuredAgentSessionOptionPicks(createStructuredAgentSessionOptionState('codex'), {
        effort: 'high'
      })
    ).toEqual([])
  })

  it('drops ids a launch cannot seed back', () => {
    expect(
      structuredAgentSessionOptionPicks(liveState({ model: 'account-model' }), {
        permissionMode: 'plan'
      })
    ).toEqual([])
  })
})

describe('applyNativeChatSessionOptionPicks', () => {
  it('keeps a later pick in the batch from dropping an earlier one', () => {
    const persisted = applyNativeChatSessionOptionPicks({
      persisted: undefined,
      agent: 'codex',
      picks: [
        { modelId: 'gpt-fast', optionId: 'model', value: 'gpt-fast' },
        { modelId: 'gpt-fast', optionId: 'effort', value: 'low' }
      ]
    })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toEqual({
      model: 'gpt-fast',
      effort: 'low'
    })
  })

  it('leaves every other agent untouched', () => {
    const persisted = applyNativeChatSessionOptionPicks({
      persisted: { claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } } },
      agent: 'codex',
      picks: [{ modelId: 'gpt-fast', optionId: 'effort', value: 'low' }]
    })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')).toEqual({
      model: 'opus',
      effort: 'high'
    })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toEqual({
      model: 'gpt-fast',
      effort: 'low'
    })
  })

  it('returns the record unchanged for an empty batch', () => {
    expect(
      applyNativeChatSessionOptionPicks({ persisted: undefined, agent: 'codex', picks: [] })
    ).toEqual({})
  })
})
