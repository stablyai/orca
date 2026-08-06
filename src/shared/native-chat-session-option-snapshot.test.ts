import { describe, expect, it } from 'vitest'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import {
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import {
  buildNativeChatSessionOptionSnapshot,
  sortNativeChatSessionOptions,
  withTrackedNativeChatModel
} from './native-chat-session-option-snapshot'

function claudeRecord(): NativeChatSessionOptionRecord {
  return createNativeChatSessionOptionRecord('claude')
}

describe('buildNativeChatSessionOptionSnapshot', () => {
  it('offers every catalog model with the current value unknown', () => {
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record: claudeRecord(),
      mode: 'live',
      modelLabel: 'Model'
    })
    expect(snapshot).toHaveLength(1)
    const model = snapshot[0]!
    expect(model).toMatchObject({ id: 'model', category: 'model', valueSource: 'unknown' })
    if (model.kind.type !== 'select') {
      throw new Error('model descriptor must be a select')
    }
    expect(model.kind.currentValue).toBeUndefined()
    expect(model.kind.choices.map((choice) => choice.value)).toEqual(
      CLAUDE_SESSION_OPTION_CATALOG.models.map((catalogModel) => catalogModel.id)
    )
  })

  it('adds the tracked model’s options once the model is known', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'dispatched' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model'
    })
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    expect(snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
  })

  it('renders exactly the models it is given, without self-healing the tracked one', () => {
    // The builder no longer appends the tracked model itself — reconciling it is
    // the caller's job (withTrackedNativeChatModel), so every row is a real choice.
    const record = claudeRecord()
    record.model = { value: 'experimental-model', source: 'reported' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model'
    })
    const model = snapshot[0]!
    if (model.kind.type !== 'select') {
      throw new Error('model descriptor must be a select')
    }
    expect(model.kind.choices.map((choice) => choice.value)).toEqual(
      CLAUDE_SESSION_OPTION_CATALOG.models.map((catalogModel) => catalogModel.id)
    )
  })

  it('is empty when the model list is empty', () => {
    expect(
      buildNativeChatSessionOptionSnapshot({
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: [],
        record: claudeRecord(),
        mode: 'live',
        modelLabel: 'Model'
      })
    ).toEqual([])
  })

  describe('sortNativeChatSessionOptions', () => {
    it('drops the model row and orders effort before model config before modes', () => {
      const descriptor = (id: string, category?: string): SessionOptionDescriptor =>
        ({
          id,
          label: id,
          ...(category ? { category } : {}),
          kind: { type: 'boolean' },
          valueSource: 'unknown',
          settable: true
        }) as SessionOptionDescriptor
      const sorted = sortNativeChatSessionOptions([
        descriptor('model', 'model'),
        descriptor('uncategorized'),
        descriptor('vim', 'mode'),
        descriptor('fastMode', 'model_config'),
        descriptor('effort', 'thought_level')
      ])
      expect(sorted.map((entry) => entry.id)).toEqual([
        'effort',
        'fastMode',
        'vim',
        'uncategorized'
      ])
    })
  })

  describe('withTrackedNativeChatModel', () => {
    it('keeps an unlisted tracked model as a choice, preferring the seed row', () => {
      const record = claudeRecord()
      record.model = { value: 'opus', source: 'reported' }
      // A discovered list that dropped the `opus` alias this host no longer lists.
      const discovered = CLAUDE_SESSION_OPTION_CATALOG.models.filter((model) => model.id !== 'opus')
      const reconciled = withTrackedNativeChatModel(
        CLAUDE_SESSION_OPTION_CATALOG,
        discovered,
        record
      )
      const restored = reconciled.find((model) => model.id === 'opus')
      expect(restored).toBeDefined()
      // The seed row carries the model's own options, so they don't vanish.
      expect(restored!.options.length).toBeGreaterThan(0)
      const snapshot = buildNativeChatSessionOptionSnapshot({
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: reconciled,
        record,
        mode: 'live',
        modelLabel: 'Model'
      })
      const model = snapshot[0]!
      if (model.kind.type !== 'select') {
        throw new Error('model descriptor must be a select')
      }
      expect(model.kind.currentValue).toBe('opus')
      expect(model.kind.choices.some((choice) => choice.value === 'opus')).toBe(true)
      expect(snapshot.length).toBeGreaterThan(1)
    })

    it('labels a wholly unknown tracked model by its id rather than dropping it', () => {
      const record = claudeRecord()
      record.model = { value: 'experimental-model', source: 'reported' }
      const reconciled = withTrackedNativeChatModel(
        CLAUDE_SESSION_OPTION_CATALOG,
        CLAUDE_SESSION_OPTION_CATALOG.models,
        record
      )
      expect(reconciled.at(-1)).toEqual({
        id: 'experimental-model',
        label: 'experimental-model',
        options: []
      })
    })

    it('leaves the list alone when the tracked model is already listed', () => {
      const record = claudeRecord()
      record.model = { value: 'sonnet', source: 'reported' }
      expect(
        withTrackedNativeChatModel(
          CLAUDE_SESSION_OPTION_CATALOG,
          CLAUDE_SESSION_OPTION_CATALOG.models,
          record
        )
      ).toEqual([...CLAUDE_SESSION_OPTION_CATALOG.models])
    })
  })

  it('exposes Codex model changes as native selectable values', () => {
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record: createNativeChatSessionOptionRecord('codex'),
      mode: 'live',
      modelLabel: 'Model'
    })
    expect(snapshot[0]).toMatchObject({ settable: true })
    expect(snapshot[0]?.action).toBeUndefined()
    expect(snapshot[0]?.kind).toMatchObject({
      type: 'select',
      choices: expect.arrayContaining([{ value: 'gpt-5.5', label: 'GPT-5.5' }])
    })
  })

  it('marks flip-only toggles without a baseline as toggle actions', () => {
    const record = claudeRecord()
    record.model = { value: 'opus', source: 'reported' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model'
    })
    const fastMode = snapshot.find((descriptor) => descriptor.id === 'fastMode')
    expect(fastMode).toMatchObject({ action: { type: 'toggle-command' } })
  })
})
