import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

describe('structured agent session options', () => {
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

  it('uses provider-scoped models and withholds a current id they do not carry', () => {
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
    // Was: a fabricated `persisted-unknown` choice. The provider never listed that id, so
    // it is tracked as the model the thread runs, but never offered and never named.
    const model = structuredAgentSessionOptionSnapshot(state)[0]
    expect(
      model.kind.type === 'select' ? model.kind.choices.map((choice) => choice.value) : []
    ).toEqual(['account-model'])
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBeUndefined()
    expect(model).toMatchObject({ valueSource: 'unknown' })
  })

  it('keeps the model row when the provider lists no models at all', () => {
    // `readCodexStructuredSessionOptions` throws only when no model resolves at all, so an
    // empty `model/list` on a restored thread reaches here with a current model. Fabricating
    // a row used to hide that; without one the snapshot must not blank the pill.
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      { models: [], current: { model: 'gpt-5.9-secret' } }
    )

    // Unconfirmed: a pick restored from a previous session, which the thread has not
    // echoed. An empty list must not promote it to a name it was never owed.
    expect(state.record.model).toEqual({ value: 'gpt-5.9-secret', source: 'dispatched' })
    const snapshot = structuredAgentSessionOptionSnapshot(state)
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model'])
    const model = snapshot[0]
    expect(model).toMatchObject({ valueSource: 'unknown' })
    expect(model.kind.type === 'select' ? model.kind.choices : null).toEqual([])
  })

  it('names the model an empty-listing provider reported, without offering it', () => {
    // The regression this rule exists to prevent: a thread whose `model/list` came back
    // empty still runs a model and says so, so the pill must name it rather than blank.
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      { models: [], current: { model: 'gpt-5.9-secret', confirmed: ['model'] } }
    )

    const model = structuredAgentSessionOptionSnapshot(state)[0]
    expect(model).toMatchObject({ valueSource: 'reported' })
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBe('gpt-5.9-secret')
    expect(model.kind.type === 'select' ? model.kind.choices : null).toEqual([])
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
})
