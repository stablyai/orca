import { describe, expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import type { SessionOptionDescriptor } from '../../native-chat/input/native-chat-session-options'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from './structured-agent-session-option-view'

const seed = getAgentSessionOptionLaunchCatalog('codex')!
const listing = (ids: readonly string[]): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  models: ids.map((id) => ({ id, label: id, isDefault: false, efforts: [] }))
})
const chat = (ids: readonly string[], model: string) =>
  commitStructuredAgentSessionOptionValues(
    applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', seed),
      seed,
      listing(ids),
      { newLaunch: false, coherentCatalog: true }
    ),
    { model }
  )
const legacyChoices = (snapshot: SessionOptionDescriptor[]) => {
  const model = snapshot.find((descriptor) => descriptor.id === 'model')
  return model?.kind.type === 'select'
    ? model.kind.choices.filter((choice) => choice.legacy).map((choice) => choice.value)
    : []
}

describe('structured chat legacy model folding', () => {
  it('classifies an unchanged catalog once across renders', () => {
    for (const families of [20, 200]) {
      const ids = ['gpt-6-sol', 'gpt-5.6-luna']
      for (let index = 0; index < families; index++) {
        ids.push(`gpt-6.1-family-${index}`)
      }
      const state = chat(ids, 'gpt-6-sol')
      let reads = 0
      const rows = state.catalog!.models.map(
        (row) =>
          new Proxy(row, {
            get: (target, key, receiver) => {
              reads += 1
              return Reflect.get(target, key, receiver)
            }
          })
      )
      const counted = { ...state, catalog: { ...state.catalog!, models: rows } }
      const readsPerRender = () => {
        reads = 0
        expect(legacyChoices(structuredAgentSessionShownSnapshot(counted))).toEqual([
          'gpt-5.6-luna'
        ])
        return reads
      }
      const first = readsPerRender()
      const later = readsPerRender()
      // The first render pays the classification scan, at least one read per listed row.
      expect(first - later).toBeGreaterThanOrEqual(ids.length)
      expect(readsPerRender()).toBe(later)
    }
  })

  it('reclassifies a replaced catalog', () => {
    expect(
      legacyChoices(structuredAgentSessionShownSnapshot(chat(['gpt-6.1-sol'], 'gpt-6.1-sol')))
    ).toEqual([])
    expect(
      legacyChoices(
        structuredAgentSessionShownSnapshot(chat(['gpt-6.2-sol', 'gpt-6.1-sol'], 'gpt-6.1-sol'))
      )
    ).toEqual(['gpt-6.1-sol'])
  })

  it('never lets a tracked-only model mark listed rows legacy', () => {
    const snapshot = structuredAgentSessionShownSnapshot(
      chat(['gpt-6-sol', 'gpt-5.6-luna'], 'gpt-7-sol')
    )
    const model = snapshot.find((descriptor) => descriptor.id === 'model')
    expect(
      model?.kind.type === 'select' && model.kind.choices.map((choice) => choice.value)
    ).toEqual(['gpt-6-sol', 'gpt-5.6-luna', 'gpt-7-sol'])
    expect(legacyChoices(snapshot)).toEqual(['gpt-5.6-luna'])
  })
})
