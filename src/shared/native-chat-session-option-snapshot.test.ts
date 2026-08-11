import { describe, expect, it } from 'vitest'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import { mergeDiscoveredAuthoritativeModels } from './agent-session-option-catalog'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
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

    it('re-injects a grok seed model an authoritative discovery dropped', () => {
      // Reconciliation alone never un-picks: the PTY surface untracks a retired id
      // when an authoritative discovery lands (see native-chat-pty-session-options),
      // while this shared layer keeps a pre-discovery persisted pick labelled.
      const record = createNativeChatSessionOptionRecord('grok')
      record.model = { value: 'grok-4.5', source: 'dispatched' }
      const discovered = mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
        { id: 'grok-build', label: 'Grok Build', options: [] }
      ])
      expect(discovered.map(({ id }) => id)).toEqual(['grok-build'])

      const reconciled = withTrackedNativeChatModel(GROK_SESSION_OPTION_CATALOG, discovered, record)
      expect(reconciled.map(({ id }) => id)).toEqual(['grok-build', 'grok-4.5'])
      expect(reconciled.at(-1)).toBe(GROK_SESSION_OPTION_CATALOG.models[0])
      expect(reconciled.at(-1)!.options.map(({ id }) => id)).toEqual(['effort'])

      const snapshot = buildNativeChatSessionOptionSnapshot({
        catalog: GROK_SESSION_OPTION_CATALOG,
        models: reconciled,
        record,
        mode: 'live',
        modelLabel: 'Model'
      })
      expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
      expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5' }).args).toEqual([
        '-m',
        'grok-4.5',
        '--reasoning-effort',
        'high'
      ])
    })
  })

  it('routes Codex model changes through its typed TUI picker', () => {
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record: createNativeChatSessionOptionRecord('codex'),
      mode: 'live',
      modelLabel: 'Model'
    })
    expect(snapshot[0]).toMatchObject({ settable: true })
    expect(snapshot[0]?.action).toEqual({ type: 'agent-picker' })
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

describe('defaults on load', () => {
  const grokDraft = (
    models = GROK_SESSION_OPTION_CATALOG.models,
    mode: 'draft' | 'live' = 'draft'
  ): SessionOptionDescriptor[] =>
    buildNativeChatSessionOptionSnapshot({
      catalog: GROK_SESSION_OPTION_CATALOG,
      models,
      record: createNativeChatSessionOptionRecord('grok'),
      mode,
      modelLabel: 'Model'
    })

  it('shows the default model before anything is picked', () => {
    const model = grokDraft()[0]!
    expect(model).toMatchObject({ id: 'model', valueSource: 'default' })
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBe('grok-4.5')
  })

  it('offers the effort row under that default model without naming its value', () => {
    // `grok --help` documents no default for --reasoning-effort, and with no model
    // picked the launch sends the flag nowhere, so grok's own choice is unknowable.
    const effort = grokDraft().find((descriptor) => descriptor.id === 'effort')
    expect(effort).toMatchObject({ valueSource: 'unknown' })
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : null).toBeUndefined()
  })

  it('names the CLI default in a live session too, where the picker actually renders', () => {
    // No tracked model means no `-m` was emitted, so the CLI is running its own
    // default — as true of a running session as of a draft.
    const live = grokDraft(GROK_SESSION_OPTION_CATALOG.models, 'live')
    expect(live[0]).toMatchObject({ id: 'model', valueSource: 'default' })
    expect(live[0]!.kind.type === 'select' ? live[0]!.kind.currentValue : null).toBe('grok-4.5')
    expect(live.find((descriptor) => descriptor.id === 'effort')).toMatchObject({
      valueSource: 'unknown'
    })
  })

  it('names no model when discovery retired the one the catalog marks default', () => {
    // Guessing a replacement would misreport which model the launch actually picks.
    const retired = mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
      { id: 'grok-build', label: 'Grok Build', options: [] }
    ])
    const snapshot = grokDraft(retired)
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('leaves a tracked pick as the authority over the default', () => {
    const record = createNativeChatSessionOptionRecord('grok')
    record.model = { value: 'grok-build', source: 'dispatched' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: GROK_SESSION_OPTION_CATALOG,
      models: [
        ...GROK_SESSION_OPTION_CATALOG.models,
        { id: 'grok-build', label: 'Grok Build', options: [] }
      ],
      record,
      mode: 'draft',
      modelLabel: 'Model'
    })
    expect(snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
    expect(snapshot[0]!.kind.type === 'select' ? snapshot[0]!.kind.currentValue : null).toBe(
      'grok-build'
    )
  })

  it('shows no default for an agent whose isDefault is only decorative', () => {
    // Claude's real default comes from the account and the user's settings, and an
    // untouched draft sends no --model, so naming the seed's `sonnet` would be a guess.
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record: claudeRecord(),
      mode: 'draft',
      modelLabel: 'Model'
    })
    expect(CLAUDE_SESSION_OPTION_CATALOG.models.some((model) => model.isDefault)).toBe(true)
    expect(CLAUDE_SESSION_OPTION_CATALOG.defaultModelIsCliDefault).toBeUndefined()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('still shows an option default once a model is actually picked', () => {
    // Not a guess: launch reads `values[id] ?? defaultValue`, so this is the flag it emits.
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'applied' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'draft',
      modelLabel: 'Model'
    })
    const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort).toMatchObject({ valueSource: 'default' })
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : null).toBeDefined()
  })

  it('does not turn a shown default into a launch flag', () => {
    // Display is not authorization: only a persisted pick may emit `-m`.
    expect(resolveAgentSessionOptionLaunch('grok', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })
})
