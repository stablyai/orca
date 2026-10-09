import { describe, expect, it } from 'vitest'
import { OMP_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-omp'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  settleStructuredAgentSessionBuiltinCatalog,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'

function viewModel(...args: Parameters<typeof structuredAgentSessionOptionView>) {
  const model = structuredAgentSessionOptionSnapshot(
    structuredAgentSessionOptionView(...args)
  ).find((descriptor) => descriptor.id === 'model')
  return model?.kind.type === 'select' ? model.kind.currentValue : undefined
}

describe('structured agent session options', () => {
  it('keeps a missing model out of the picker and adopts a later report', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('omp'),
      OMP_SESSION_OPTION_CATALOG,
      { models: [], current: { effort: 'off', confirmed: ['effort'] } }
    )
    expect(state.catalog?.models).toEqual([])
    expect(structuredAgentSessionOptionSnapshot(state)).toEqual([])
    expect(state.record.model).toBeUndefined()

    const reported = applyStructuredAgentSessionOptions(state, OMP_SESSION_OPTION_CATALOG, {
      models: [{ id: 'reported-model', label: 'Reported Model', isDefault: true, efforts: [] }],
      current: { model: 'reported-model', confirmed: ['model'] }
    })
    expect(structuredAgentSessionOptionSnapshot(reported)[0]).toMatchObject({
      valueSource: 'reported',
      kind: {
        currentValue: 'reported-model',
        choices: [{ value: 'reported-model', label: 'Reported Model' }]
      }
    })
  })

  it('projects native Codex selects while bridge Codex keeps its agent picker', () => {
    const state = applyStructuredAgentSessionOptions(
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
          }
        ],
        current: { model: 'account-model', effort: 'medium' }
      }
    )

    const structured = structuredAgentSessionOptionSnapshot(state)
    expect(structured.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    expect(structured[0]).toMatchObject({
      settable: true,
      kind: { type: 'select', currentValue: 'account-model' }
    })
    expect(structured[0]).not.toHaveProperty('action')
    expect(structured[1]).toMatchObject({
      settable: true,
      kind: { type: 'select', currentValue: 'medium' }
    })

    const bridgeRecord = createNativeChatSessionOptionRecord('codex')
    bridgeRecord.model = { value: 'gpt-5.6-sol', source: 'reported' }
    const bridge = buildNativeChatSessionOptionSnapshot({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record: bridgeRecord,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })
    // Same catalog, same `dispatched` vocabulary — only the transport separates them.
    expect(structured.every((descriptor) => descriptor.transport === 'agent-session')).toBe(true)
    expect(bridge.every((descriptor) => descriptor.transport === 'catalog')).toBe(true)
    expect(bridge[0]).toMatchObject({ action: { type: 'agent-picker' } })
    expect(bridge.find((descriptor) => descriptor.id === 'effort')).toMatchObject({
      action: { type: 'agent-picker' }
    })
  })

  it('uses provider-scoped models and retains the current unknown id', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: false,
            efforts: []
          }
        ],
        current: { model: 'persisted-unknown' }
      }
    )
    const model = structuredAgentSessionOptionSnapshot(state)[0]
    expect(
      model.kind.type === 'select' ? model.kind.choices.map((choice) => choice.value) : []
    ).toEqual(['account-model', 'persisted-unknown'])
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBe('persisted-unknown')
  })

  it('projects live options as directly settable descriptors', () => {
    const state = applyStructuredAgentSessionOptions(
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
          }
        ],
        current: { model: 'account-model', effort: 'medium' }
      }
    )

    const snapshot = structuredAgentSessionOptionSnapshot(state)
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    expect(snapshot.every((descriptor) => descriptor.settable)).toBe(true)
    expect(snapshot.every((descriptor) => descriptor.action === undefined)).toBe(true)
  })

  it('projects Fast mode only from positive session and model capability', () => {
    const supported = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: true,
            efforts: [],
            supportsFastMode: true
          }
        ],
        fastModeSupport: { supported: true },
        current: { model: 'account-model', fastMode: false, confirmed: ['fastMode'] }
      }
    )
    expect(structuredAgentSessionOptionSnapshot(supported)).toContainEqual(
      expect.objectContaining({
        id: 'fastMode',
        kind: { type: 'boolean', currentValue: false },
        valueSource: 'reported',
        settable: true
      })
    )

    const absent = applyStructuredAgentSessionOptions(supported, CODEX_SESSION_OPTION_CATALOG, {
      models: [
        {
          id: 'account-model',
          label: 'Account Model',
          isDefault: true,
          efforts: [],
          supportsFastMode: true
        }
      ],
      current: { model: 'account-model' }
    })
    expect(structuredAgentSessionOptionSnapshot(absent).map(({ id }) => id)).toEqual(['model'])
    expect(absent.record.valuesByModel['account-model']?.fastMode).toBeUndefined()
  })

  it('renders Fast off but marked unreported when support is known and no value is', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: true,
            efforts: [],
            supportsFastMode: true
          }
        ],
        fastModeSupport: { supported: true },
        current: { model: 'account-model' }
      }
    )

    // The switch has no third position, so the value resolves to the catalog's
    // own `false`. `unknown` is what stops any surface calling that a default:
    // `default` is unreachable in this lane (it is hardcoded `mode: 'live'`), and
    // nothing here has reported the tier the thread is actually routing.
    expect(structuredAgentSessionOptionSnapshot(state)).toContainEqual(
      expect.objectContaining({
        id: 'fastMode',
        kind: { type: 'boolean', currentValue: false },
        valueSource: 'unknown'
      })
    )
  })

  it('shows the launch seed until the record names a model, and held picks over both', () => {
    const cold = createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG)
    const seeded = applyStructuredAgentSessionModelCatalog(
      cold,
      CODEX_SESSION_OPTION_CATALOG,
      {
        origin: 'probe',
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true, efforts: [] }],
        fetchedAt: 1
      },
      { newLaunch: true }
    )
    const seed = { model: 'gpt-5.5' }
    expect(viewModel(seeded, seed, {})).toBe('gpt-5.5')
    // A saved pick the host's list does not name shows the quiet placeholder, never its raw id.
    expect(
      structuredAgentSessionOptionSnapshot(
        structuredAgentSessionOptionView(seeded, { model: 'gpt-next' }, {})
      )
    ).toEqual([expect.objectContaining({ id: 'model', settable: false, valueSource: 'unknown' })])
    // Before the host answers, and on the built-in list, no saved pick is named.
    expect(viewModel(cold, seed, {})).toBeUndefined()
    expect(viewModel(settleStructuredAgentSessionBuiltinCatalog(cold), seed, {})).toBeUndefined()
    // Derived only: the record itself never takes the seed.
    expect(seeded.record.model).toBeUndefined()
    const live = applyStructuredAgentSessionOptions(seeded, CODEX_SESSION_OPTION_CATALOG, {
      models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', isDefault: true, efforts: [] }],
      current: { model: 'gpt-5.6-luna', confirmed: ['model'] }
    })
    expect(viewModel(live, seed, {})).toBe('gpt-5.6-luna')
    expect(viewModel(live, seed, { model: 'gpt-5.5' })).toBe('gpt-5.5')
    expect(live.record.model?.value).toBe('gpt-5.6-luna')
  })
})
