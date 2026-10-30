import { describe, expect, it } from 'vitest'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor
} from './native-chat-session-options'
import { mergeDiscoveredAuthoritativeModels } from '../../agent-session-option-catalog'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../agent-session-option-catalog-claude-codex'
import { CURSOR_SESSION_OPTION_CATALOG } from '../../agent-session-option-catalog-gemini-cursor'
import { GROK_SESSION_OPTION_CATALOG } from '../../agent-session-option-catalog-grok'
import { resolveAgentSessionOptionLaunch } from '../../agent-session-option-launch'
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
  // Both lanes emit dispatched; only an explicit transport distinguishes their descriptors.
  it.each(['catalog', 'agent-session'] as const)(
    'stamps every descriptor with the %s transport it was built for',
    (liveTransport) => {
      const record = claudeRecord()
      record.model = { value: 'sonnet', source: 'dispatched' }
      const snapshot = buildNativeChatSessionOptionSnapshot({
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record,
        mode: 'live',
        modelLabel: 'Model',
        liveTransport
      })
      expect(snapshot.length).toBeGreaterThan(1)
      expect(snapshot.every((descriptor) => descriptor.transport === liveTransport)).toBe(true)
      const dispatched = snapshot.filter((descriptor) => descriptor.valueSource === 'dispatched')
      expect(dispatched.length).toBeGreaterThan(0)
      expect(dispatched.every(sessionOptionDispatchUnconfirmed)).toBe(liveTransport === 'catalog')
    }
  )

  it('offers every catalog model with the current value unknown', () => {
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record: claudeRecord(),
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
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
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    expect(snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
  })

  it('renders exactly the models it is given, without self-healing the tracked one', () => {
    // Callers reconcile tracked models with withTrackedNativeChatModel; builders must list actual choices only.
    const record = claudeRecord()
    record.model = { value: 'experimental-model', source: 'reported' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
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
        modelLabel: 'Model',
        liveTransport: 'catalog'
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
        modelLabel: 'Model',
        liveTransport: 'catalog'
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
      // PTY retires picks after authoritative discovery; shared reconciliation retains labeled pre-discovery selections.
      const record = createNativeChatSessionOptionRecord('grok')
      record.model = { value: 'grok-4.5', source: 'dispatched' }
      const discovered = mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
        { id: 'grok-build', label: 'Grok Build', options: [] }
      ])
      expect(discovered.map(({ id }) => id)).toEqual(['grok-build'])

      const reconciled = withTrackedNativeChatModel(GROK_SESSION_OPTION_CATALOG, discovered, record)
      expect(reconciled.map(({ id }) => id)).toEqual(['grok-build', 'grok-4.5'])
      expect(reconciled.at(-1)).toBe(
        GROK_SESSION_OPTION_CATALOG.models.find((model) => model.id === 'grok-4.5')
      )
      expect(reconciled.at(-1)!.options.map(({ id }) => id)).toEqual(['effort'])

      const snapshot = buildNativeChatSessionOptionSnapshot({
        catalog: GROK_SESSION_OPTION_CATALOG,
        models: reconciled,
        record,
        mode: 'live',
        modelLabel: 'Model',
        liveTransport: 'catalog'
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

  it('describes Codex model changes as agent-picker actions', () => {
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record: createNativeChatSessionOptionRecord('codex'),
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
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
      modelLabel: 'Model',
      liveTransport: 'catalog'
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
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })

  it('shows the default model before anything is picked', () => {
    const model = grokDraft()[0]!
    expect(model).toMatchObject({ id: 'model', valueSource: 'default' })
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBe('grok-4.7')
  })

  it('offers the effort row under that default model without naming its value', () => {
    // Grok documents no effort default and unpicked launches emit no flag, so the CLI choice is unknown.
    const effort = grokDraft().find((descriptor) => descriptor.id === 'effort')
    expect(effort).toMatchObject({ valueSource: 'unknown' })
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : null).toBeUndefined()
  })

  it('names the CLI default in a live session too, where the picker actually renders', () => {
    // No tracked model means no -m was sent; the running CLI uses its own default too.
    const live = grokDraft(GROK_SESSION_OPTION_CATALOG.models, 'live')
    expect(live[0]).toMatchObject({ id: 'model', valueSource: 'default' })
    expect(live[0]!.kind.type === 'select' ? live[0]!.kind.currentValue : null).toBe('grok-4.7')
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
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })
    expect(snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
    expect(snapshot[0]!.kind.type === 'select' ? snapshot[0]!.kind.currentValue : null).toBe(
      'grok-build'
    )
  })

  it('shows no default for an agent whose isDefault is only decorative', () => {
    // Claude’s account/settings choose its real default; untouched launches send no --model, so seeded sonnet is unproven.
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record: claudeRecord(),
      mode: 'draft',
      modelLabel: 'Model',
      liveTransport: 'catalog'
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
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })
    const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort).toMatchObject({ valueSource: 'default' })
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : null).toBe('high')
  })
})

describe('a boolean option always carries a value to render', () => {
  // Cursor defaults thinking true; omitting the display value would falsely render the switch off.
  function cursorSnapshot(mode: 'draft' | 'live'): SessionOptionDescriptor[] {
    const record = createNativeChatSessionOptionRecord('cursor')
    record.model = { value: 'claude-opus-4-8', source: 'reported' }
    return buildNativeChatSessionOptionSnapshot({
      catalog: CURSOR_SESSION_OPTION_CATALOG,
      models: CURSOR_SESSION_OPTION_CATALOG.models,
      record,
      mode,
      modelLabel: 'Model',
      liveTransport: mode === 'live' ? 'agent-session' : 'catalog'
    })
  }
  const thinkingOf = (mode: 'draft' | 'live'): SessionOptionDescriptor | undefined =>
    cursorSnapshot(mode).find((descriptor) => descriptor.id === 'thinking')

  it('resolves an unreported live boolean to the catalog default, not to off', () => {
    // Switches cannot display unknown; resolve to the same default used by composed dispatch.
    const thinking = thinkingOf('live')
    expect(thinking?.kind.type).toBe('boolean')
    expect(thinking?.kind.type === 'boolean' ? thinking.kind.currentValue : null).toBe(true)
  })

  it('keeps provenance on its own track when it resolves that value', () => {
    // Resolved display values are not agent confirmation; keep provenance unknown/default for pills.
    expect(thinkingOf('live')).toMatchObject({ valueSource: 'unknown' })
    expect(thinkingOf('draft')).toMatchObject({ valueSource: 'default' })
  })

  it('resolves a tracked boolean to the tracked value, not the catalog default', () => {
    const record = createNativeChatSessionOptionRecord('cursor')
    record.model = { value: 'claude-opus-4-8', source: 'reported' }
    record.valuesByModel['claude-opus-4-8'] = { thinking: { value: false, source: 'reported' } }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CURSOR_SESSION_OPTION_CATALOG,
      models: CURSOR_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'agent-session'
    })
    const thinking = snapshot.find((descriptor) => descriptor.id === 'thinking')
    expect(thinking?.kind.type === 'boolean' ? thinking.kind.currentValue : null).toBe(false)
    expect(thinking).toMatchObject({ valueSource: 'reported' })
  })

  it('leaves a select able to render nothing selected', () => {
    // Only the boolean kind resolves: a radio group can show no selection
    // truthfully, so nothing forces a value onto it.
    const effort = cursorSnapshot('live')!.find((descriptor) => descriptor.id === 'effort')
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : null).toBeUndefined()
    expect(effort).toMatchObject({ valueSource: 'unknown' })
  })

  it('includes composed launch defaults only when requested', () => {
    // Composed model uses caller picks, never display descriptors; resolving a switch cannot alter dispatch.
    expect(resolveAgentSessionOptionLaunch('cursor', { model: 'claude-opus-4-8' })).toEqual({
      args: ['--model', 'claude-opus-4-8-thinking-high'],
      appliedValues: { model: 'claude-opus-4-8', thinking: true, effort: 'high' }
    })
    expect(
      resolveAgentSessionOptionLaunch('cursor', { model: 'claude-opus-4-8' }, [], false)
    ).toEqual({
      args: ['--model', 'claude-opus-4-8'],
      appliedValues: { model: 'claude-opus-4-8' }
    })
  })
})
