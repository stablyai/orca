import { expect, it } from 'vitest'
import type { AgentSessionChoiceCatalog, AgentSessionModelOption } from './agent-session-wire'
import {
  ageStructuredAgentChoiceCatalog,
  invalidateStructuredAgentChoiceCatalog
} from './structured-agent-session-choice-catalog'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import {
  structuredAgentSessionListedPicks,
  structuredAgentSessionSendSelection
} from './structured-agent-session-option-view'

const seed = structuredAgentSessionSeedCatalog('claude')
const row = (id: string, isDefault = true): AgentSessionModelOption => ({
  id,
  label: id,
  isDefault,
  efforts: [
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' }
  ],
  supportsFastMode: true
})
const catalog = (
  authority: 'session' | 'discovery',
  models: AgentSessionModelOption[],
  scopeId = authority
): AgentSessionChoiceCatalog => ({
  authority,
  scopeId,
  models,
  complete: true,
  freshForMs: 120_000,
  fastModeSupport: { supported: true }
})

it.each(['catalog-first', 'options-first'] as const)(
  'uses one process authority through exit and restart: %s',
  (order) => {
    let state = commitStructuredAgentSessionOptionValues(
      createStructuredAgentSessionOptionState('claude', seed),
      { model: 'saved-model', effort: 'high' }
    )
    const process = catalog('session', [row('opus[1m]')])
    const applyCatalog = () => {
      state = applyStructuredAgentSessionModelCatalog(
        state,
        seed,
        {
          origin: 'unknown',
          choiceCatalog: { ...process, models: [], complete: false, freshForMs: 0 }
        },
        { newLaunch: false }
      )
    }
    const applyOptions = () => {
      state = applyStructuredAgentSessionOptions(state, seed, {
        models: process.models,
        current: { model: 'saved-model' },
        choiceAuthority: 'session',
        choiceCatalog: process
      })
    }
    if (order === 'catalog-first') {
      applyCatalog()
      expect(structuredAgentSessionListedPicks(state, undefined, {})).toBeNull()
      applyOptions()
    } else {
      applyOptions()
      applyCatalog()
      applyOptions()
    }
    expect(structuredAgentSessionListedPicks(state, undefined, {})).toEqual({
      model: 'opus[1m]',
      effort: 'high'
    })
    state = invalidateStructuredAgentChoiceCatalog(state)
    expect(structuredAgentSessionListedPicks(state, undefined, {})).toBeNull()
    const discovery = catalog('discovery', [row('opus')])
    state = applyStructuredAgentSessionModelCatalog(
      state,
      seed,
      { origin: 'unknown', choiceCatalog: discovery },
      { newLaunch: false }
    )
    expect(structuredAgentSessionListedPicks(state, undefined, {})).toEqual({
      model: 'opus',
      effort: 'high'
    })
    const restarted = { ...process, scopeId: 'next-generation' }
    state = applyStructuredAgentSessionOptions(state, seed, {
      models: process.models,
      current: { model: 'saved-model' },
      choiceAuthority: 'session',
      choiceCatalog: restarted,
      fastModeSupport: { supported: false }
    })
    expect(
      structuredAgentSessionOptionSnapshot(state).some((option) => option.id === 'fastMode')
    ).toBe(false)
    const delayed = ageStructuredAgentChoiceCatalog(
      { origin: 'unknown' as const, choiceCatalog: discovery },
      120_001
    )
    state = applyStructuredAgentSessionModelCatalog(state, seed, delayed, { newLaunch: false })
    expect(structuredAgentSessionListedPicks(state, undefined, {})).toBeNull()
    state = applyStructuredAgentSessionModelCatalog(
      state,
      seed,
      { origin: 'unknown', choiceCatalog: { ...discovery, complete: false } },
      { newLaunch: false }
    )
    expect(structuredAgentSessionListedPicks(state, undefined, {})).toBeNull()
  }
)

it.each(['catalog-first', 'options-first'] as const)(
  'keeps configured display provisional in either response order: %s',
  (order) => {
    let state = createStructuredAgentSessionOptionState('claude', seed)
    const choiceCatalog = {
      ...catalog('discovery', [row('recommended'), row('configured', false)]),
      configured: { model: 'configured', effort: 'max' }
    }
    const applyCatalog = () => {
      state = applyStructuredAgentSessionModelCatalog(
        state,
        seed,
        { origin: 'unknown', choiceCatalog },
        { newLaunch: true }
      )
    }
    const applyOptions = () => {
      state = applyStructuredAgentSessionOptions(state, seed, {
        models: [],
        current: {},
        choiceAuthority: 'discovery'
      })
    }
    if (order === 'catalog-first') {
      applyCatalog()
      applyOptions()
    } else {
      applyOptions()
      applyCatalog()
    }
    const snapshot = structuredAgentSessionOptionSnapshot(state)
    expect(snapshot.find((option) => option.id === 'model')?.kind).toMatchObject({
      currentValue: 'configured'
    })
    expect(structuredAgentSessionSendSelection('claude', snapshot, true)).toBeUndefined()
    state = commitStructuredAgentSessionOptionValues(state, { model: 'selection-only' })
    expect(structuredAgentSessionListedPicks(state, undefined, {})).toEqual({
      model: 'recommended'
    })
  }
)
