import { expect, it } from 'vitest'
import recording from '../../fixtures/agent-picker-cli-recordings.json'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import { createStructuredAgentSessionOptionsReadOwner } from './structured-agent-session-options-read-owner'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'
import {
  createStructuredAgentSessionOptionState,
  commitStructuredAgentSessionOptionValues
} from './structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from './structured-agent-session-option-view'
import { modelMenuOptions } from './model-menu-options'

const seed = structuredAgentSessionSeedCatalog('codex')!
const listed: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: true,
  models: recording.modelList.data.map((row) => ({
    id: row.id,
    label: row.displayName,
    isDefault: true,
    defaultEffort: row.defaultReasoningEffort,
    efforts: row.supportedReasoningEfforts.map((effort) => ({
      value: effort.reasoningEffort,
      label: effort.reasoningEffort
    }))
  }))
}
const input = {
  agent: 'codex',
  surface: 'chat' as const,
  seed,
  newLaunch: true,
  seedsModel: true,
  coherentCatalog: true
}

// The structured phone composer retains this reader and projects its state with structuredAgentSessionShownSnapshot.
it('keeps the menu wrapper aligned with the phone composer reader for pending, live and unlisted choices', () => {
  const initial = () => createStructuredAgentSessionOptionState('codex', seed)
  const reader = createStructuredAgentSessionOptionsReadOwner(initial())
  const detach = reader.attach({
    owner: ['phone', 'chat'],
    reset: ['live'],
    sessionId: 'chat',
    fence: 1,
    seed: initial,
    controller: createStructuredSessionSelectionController(() => {}),
    eligible: true,
    optionCatalog: seed,
    newLaunch: true,
    coherentCatalog: true,
    authority: () => 'same-host',
    isCurrent: () => true,
    request: () => new Promise(() => {})
  })
  const phoneSnapshot = () => structuredAgentSessionShownSnapshot(reader.getSnapshot().optionState)
  try {
    reader.receiveCatalog({ origin: 'unknown', listingInProgress: true }, 'progress')
    const pending = modelMenuOptions({ origin: 'unknown', listingInProgress: true }, input)
    for (const descriptors of [pending.descriptors, phoneSnapshot()]) {
      expect(descriptors.find(({ id }) => id === 'model')).toMatchObject({
        settable: false,
        kind: { type: 'select', choices: [] }
      })
    }
    reader.receiveCatalog(listed, 'settled')
    for (const descriptors of [modelMenuOptions(listed, input).descriptors, phoneSnapshot()]) {
      expect(descriptors.find(({ id }) => id === 'model')).toMatchObject({
        settable: true,
        kind: { choices: [{ value: 'gpt-5.6-sol' }] }
      })
      expect(descriptors.find(({ id }) => id === 'effort')).toMatchObject({
        kind: {
          choices: [
            { value: 'low' },
            { value: 'medium' },
            { value: 'high' },
            { value: 'xhigh' },
            { value: 'max' },
            { value: 'ultra' }
          ]
        }
      })
    }
    const saved = { model: 'retired-model', effort: 'saved-level' }
    reader.updateOptionState((state) => commitStructuredAgentSessionOptionValues(state, saved))
    for (const descriptors of [
      modelMenuOptions(listed, { ...input, saved }).descriptors,
      phoneSnapshot()
    ]) {
      expect(descriptors.find(({ id }) => id === 'model')?.kind).toMatchObject({
        currentValue: 'retired-model'
      })
      expect(descriptors.find(({ id }) => id === 'effort')).toMatchObject({
        settable: false,
        kind: {
          currentValue: 'saved-level',
          choices: [{ value: 'saved-level', label: 'saved-level' }]
        }
      })
    }
  } finally {
    detach()
  }
})
