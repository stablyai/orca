import { expect, it, vi } from 'vitest'
import recording from '../../fixtures/agent-picker-cli-recordings.json'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import { createStructuredAgentSessionOptionsReadOwner } from './structured-agent-session-options-read-owner'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  commitStructuredAgentSessionOptionValues
} from './structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from './structured-agent-session-option-view'
import { modelMenuOptions } from './model-menu-options'
import { structuredAgentSessionFirstFrameOptionState } from './structured-agent-session-first-frame'

import {
  selectHostModelCatalogSnapshot,
  withHostModelCatalogAnswer,
  type HostModelCatalogSnapshot
} from './host-model-catalog-snapshot-rules'

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

it('keeps the phone reader session-options source when the old host catalog method is unavailable', async () => {
  const initial = () => createStructuredAgentSessionOptionState('codex', seed)
  const reader = createStructuredAgentSessionOptionsReadOwner(initial())
  const detach = reader.attach({
    owner: ['phone', 'old-host'],
    reset: ['live'],
    sessionId: 'chat',
    fence: 1,
    seed: initial,
    controller: createStructuredSessionSelectionController(() => {}),
    eligible: true,
    optionCatalog: seed,
    newLaunch: false,
    coherentCatalog: false,
    authority: () => 'same-host',
    isCurrent: () => true,
    request: async () => ({
      models: [{ id: 'legacy-account', label: 'Legacy account', isDefault: true, efforts: [] }],
      current: { model: 'legacy-account' }
    })
  })
  try {
    reader.receiveCatalog(null, 'settled')
    await vi.waitFor(() =>
      expect(
        structuredAgentSessionShownSnapshot(reader.getSnapshot().optionState).find(
          ({ id }) => id === 'model'
        )?.kind
      ).toMatchObject({ choices: [{ value: 'legacy-account' }], currentValue: 'legacy-account' })
    )
  } finally {
    detach()
  }
})

it('retains exact account answers while non-exact phone seeds await their own listing', () => {
  let snapshot: HostModelCatalogSnapshot | undefined
  for (const answer of [
    { origin: 'probe', fetchedAt: 2, models: [] },
    { origin: 'unknown' },
    { ...listed, listingNamesConfiguredModel: false }
  ] satisfies AgentSessionModelCatalogResult[]) {
    snapshot = withHostModelCatalogAnswer(snapshot, 'id:old', listed)
    snapshot = withHostModelCatalogAnswer(snapshot, null, answer)
    expect(snapshot?.account).toEqual(answer)
    expect(snapshot?.byWorktree.size).toBe(0)
    for (const progress of [
      { origin: 'unknown', listingInProgress: true },
      { origin: 'probe', fetchedAt: 3, models: [], listingInProgress: true }
    ] satisfies AgentSessionModelCatalogResult[]) {
      expect(withHostModelCatalogAnswer(snapshot, null, progress)).toBe(snapshot)
    }
    const retained = selectHostModelCatalogSnapshot(snapshot, {
      worktree: null,
      newLaunch: true,
      seedsModel: false
    })
    expect(retained).toEqual(answer)
    const menu = modelMenuOptions(retained, { ...input, seedsModel: false })
    expect(menu.status).toBe(answer.origin === 'unknown' ? 'builtin' : 'listed')
    if (answer.origin !== 'unknown') {
      expect(menu.rows.map(({ id }) => id)).toEqual(answer.models.length ? ['gpt-5.6-sol'] : [])
    }
    const negative = answer.origin === 'unknown' || answer.models.length === 0
    snapshot = withHostModelCatalogAnswer(snapshot, 'id:y', listed)
    for (const worktree of [undefined, 'id:x']) {
      const held = selectHostModelCatalogSnapshot(snapshot, {
        worktree,
        newLaunch: true,
        seedsModel: false
      })
      expect(held).toEqual(negative ? undefined : answer)
      const firstFrame = structuredAgentSessionFirstFrameOptionState('codex', seed, held, input)
      const model = structuredAgentSessionShownSnapshot(firstFrame).find(({ id }) => id === 'model')
      if (negative) {
        expect(firstFrame.catalogSource).toBe('seed')
        expect(model).toMatchObject({ settable: false, kind: { type: 'select', choices: [] } })
        expect(model?.kind.currentValue).toBeUndefined()
        expect(firstFrame.record.values.model).toBeUndefined()
        expect(modelMenuOptions(held, { ...input, pending: true }).status).toBe('listing')
      } else {
        expect(model?.kind).toMatchObject({ choices: [{ value: 'gpt-5.6-sol' }] })
      }
      const settled = applyStructuredAgentSessionModelCatalog(firstFrame, seed, answer, input)
      expect(settled.catalogSource).toBe(answer.origin === 'unknown' ? 'builtin' : 'host')
      const settledModel = structuredAgentSessionShownSnapshot(settled).find(
        ({ id }) => id === 'model'
      )
      if (answer.origin === 'unknown') {
        expect(settledModel?.settable).toBe(true)
        expect(settledModel?.kind).toMatchObject({
          choices: expect.arrayContaining([expect.objectContaining({ value: 'gpt-5.6-sol' })])
        })
      } else {
        expect(settledModel?.kind).toMatchObject({
          choices: answer.models.length ? [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }] : []
        })
      }
    }
    if (negative) {
      snapshot = withHostModelCatalogAnswer(snapshot, 'id:x', listed)
      expect(selectHostModelCatalogSnapshot(snapshot, { ...input, worktree: 'id:x' })).toBe(listed)
      snapshot = withHostModelCatalogAnswer(snapshot, 'id:x', answer)
      expect(selectHostModelCatalogSnapshot(snapshot, { ...input, worktree: 'id:x' })).toBe(answer)
      snapshot = withHostModelCatalogAnswer(snapshot, '', answer)
      expect(selectHostModelCatalogSnapshot(snapshot, input)).toBe(answer)
      expect(selectHostModelCatalogSnapshot(snapshot, { ...input, worktree: null })).toBe(answer)
    }
  }
})
