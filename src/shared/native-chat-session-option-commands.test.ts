import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok'
import {
  buildNativeChatSessionOptionCommand,
  parseBuiltSessionOptionCommand,
  recordNativeChatSessionOptionCommand
} from './native-chat-session-option-commands'
import {
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'

function claudeRecord(model?: string): NativeChatSessionOptionRecord {
  const record = createNativeChatSessionOptionRecord('claude')
  if (model) {
    record.model = { value: model, source: 'dispatched' }
  }
  return record
}

describe('buildNativeChatSessionOptionCommand', () => {
  it('builds the catalog midSession command for model and options', () => {
    expect(
      buildNativeChatSessionOptionCommand({
        optionId: 'model',
        value: 'opus',
        apply: CLAUDE_SESSION_OPTION_CATALOG.modelApply,
        modelId: null,
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record: claudeRecord()
      })
    ).toBe('/model opus')
    const effortApply = CLAUDE_SESSION_OPTION_CATALOG.models
      .find((model) => model.id === 'sonnet')!
      .options.find((option) => option.id === 'effort')!.apply
    expect(
      buildNativeChatSessionOptionCommand({
        optionId: 'effort',
        value: 'high',
        apply: effortApply,
        modelId: 'sonnet',
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record: claudeRecord('sonnet')
      })
    ).toBe('/effort high')
  })

  it('returns the bare toggle command for flip-only options', () => {
    const fastModeApply = CLAUDE_SESSION_OPTION_CATALOG.models
      .find((model) => model.id === 'opus')!
      .options.find((option) => option.id === 'fastMode')!.apply
    expect(
      buildNativeChatSessionOptionCommand({
        optionId: 'fastMode',
        value: true,
        apply: fastModeApply,
        modelId: 'opus',
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record: claudeRecord('opus')
      })
    ).toBe('/fast')
  })

  it('does not turn a Codex model pick into pasted slash-command prose', () => {
    expect(
      buildNativeChatSessionOptionCommand({
        optionId: 'model',
        value: 'gpt-5.5',
        apply: CODEX_SESSION_OPTION_CATALOG.modelApply,
        modelId: null,
        catalog: CODEX_SESSION_OPTION_CATALOG,
        models: CODEX_SESSION_OPTION_CATALOG.models,
        record: createNativeChatSessionOptionRecord('codex')
      })
    ).toBeNull()
    expect(CODEX_SESSION_OPTION_CATALOG.modelApply.midSession).toEqual({
      kind: 'agent-picker',
      command: '/model',
      delivery: 'type'
    })
  })
})

describe('parseBuiltSessionOptionCommand', () => {
  it('recovers the value from a built command and rejects other text', () => {
    const build = (value: unknown): string => `/model ${String(value)}`
    expect(parseBuiltSessionOptionCommand(build, '/model opus')).toBe('opus')
    expect(parseBuiltSessionOptionCommand(build, '/effort high')).toBeNull()
    expect(parseBuiltSessionOptionCommand(build, '/model ')).toBeNull()
  })
})

describe('recordNativeChatSessionOptionCommand', () => {
  it('tracks a typed /model value as dispatched truth', () => {
    const record = claudeRecord()
    const result = recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      command: '/model sonnet'
    })
    expect(result).toEqual({ changed: true, opensAgentPicker: false })
    expect(record.model).toEqual({ value: 'sonnet', source: 'dispatched' })
  })

  it('tracks a typed option value under the current model', () => {
    const record = claudeRecord('sonnet')
    recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      command: '/effort low'
    })
    expect(record.valuesByModel.sonnet?.effort).toEqual({ value: 'low', source: 'dispatched' })
  })

  it('clears tracked truth for a bare picker command and reports the agent picker', () => {
    const claudeResult = recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record: claudeRecord('sonnet'),
      command: '/model'
    })
    expect(claudeResult.opensAgentPicker).toBe(true)
    const codexRecord = createNativeChatSessionOptionRecord('codex')
    codexRecord.model = { value: 'gpt-5.5', source: 'dispatched' }
    const codexResult = recordNativeChatSessionOptionCommand({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record: codexRecord,
      command: '/model'
    })
    expect(codexResult).toEqual({ changed: true, opensAgentPicker: true })
    expect(codexRecord.model).toBeUndefined()
  })

  it('clears a flip-only toggle’s tracked baseline on a typed flip', () => {
    const record = claudeRecord('opus')
    record.valuesByModel.opus = { fastMode: { value: true, source: 'applied' } }
    recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      command: '/fast'
    })
    // A typed flip inverts an unknown-to-us direction; the baseline is gone.
    expect(record.valuesByModel.opus?.fastMode).toBeUndefined()
  })

  it('rejects prose that merely starts with a command template', () => {
    // The `/model ` prefix matches this, so an unvalidated parse tracked
    // "is a weird word" as the current model — which then rendered as the pill
    // label and, matching no catalog model, dropped every per-model option.
    const record = claudeRecord('sonnet')
    expect(
      recordNativeChatSessionOptionCommand({
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record,
        command: '/model is a weird word'
      })
    ).toEqual({ changed: false, opensAgentPicker: false })
    expect(record.model).toEqual({ value: 'sonnet', source: 'dispatched' })
  })

  it('rejects an option value outside the catalog choices', () => {
    const record = claudeRecord('sonnet')
    recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      command: '/effort of will is required'
    })
    expect(record.valuesByModel.sonnet?.effort).toBeUndefined()
  })

  it('tracks nothing for a multi-line paste whose first line looks like a command', () => {
    const record = claudeRecord('opus')
    recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      command: '/model sonnet\nplease review this'
    })
    expect(record.model).toEqual({ value: 'opus', source: 'dispatched' })
  })

  it('still accepts an alias, a full provider id, and extra spacing', () => {
    for (const [command, expected] of [
      ['/model opus', 'opus'],
      ['/model claude-sonnet-5', 'sonnet'],
      ['/model  sonnet', 'sonnet']
    ] as const) {
      const record = claudeRecord()
      recordNativeChatSessionOptionCommand({
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record,
        command
      })
      expect(record.model).toEqual({ value: expected, source: 'dispatched' })
    }
  })

  it('still tracks an alias the active model list no longer carries', () => {
    // Per-host discovery can drop the `opus` alias; typing it is still valid and
    // callers reconcile the row back, so rejecting it would lose the selection.
    const record = claudeRecord('sonnet')
    const discovered = CLAUDE_SESSION_OPTION_CATALOG.models.filter((model) => model.id !== 'opus')
    recordNativeChatSessionOptionCommand({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: discovered,
      record,
      command: '/model opus'
    })
    expect(record.model).toEqual({ value: 'opus', source: 'dispatched' })
  })

  it('ignores unrelated commands', () => {
    const record = claudeRecord('sonnet')
    expect(
      recordNativeChatSessionOptionCommand({
        catalog: CLAUDE_SESSION_OPTION_CATALOG,
        models: CLAUDE_SESSION_OPTION_CATALOG.models,
        record,
        command: '/clear'
      })
    ).toEqual({ changed: false, opensAgentPicker: false })
  })
})

describe('recordNativeChatSessionOptionCommand for grok', () => {
  function grokRecord(model?: string): NativeChatSessionOptionRecord {
    const record = createNativeChatSessionOptionRecord('grok')
    if (model) {
      record.model = { value: model, source: 'dispatched' }
    }
    return record
  }

  function recordGrok(record: NativeChatSessionOptionRecord, command: string) {
    return recordNativeChatSessionOptionCommand({
      catalog: GROK_SESSION_OPTION_CATALOG,
      models: GROK_SESSION_OPTION_CATALOG.models,
      record,
      command
    })
  }

  it('tracks a typed /model without signalling an agent picker', () => {
    const record = grokRecord()
    expect(recordGrok(record, '/model grok-4.5')).toEqual({
      changed: true,
      opensAgentPicker: false
    })
    expect(record.model).toEqual({ value: 'grok-4.5', source: 'dispatched' })
  })

  it('persists the typed model through the caller’s persist hook', () => {
    const persist = vi.fn()
    recordNativeChatSessionOptionCommand({
      catalog: GROK_SESSION_OPTION_CATALOG,
      models: GROK_SESSION_OPTION_CATALOG.models,
      record: grokRecord(),
      command: '/model grok-4.5',
      persist
    })
    expect(persist).toHaveBeenCalledWith('grok-4.5', 'model', 'grok-4.5')
  })

  it('tracks effort under the current model', () => {
    const record = grokRecord('grok-4.5')
    expect(recordGrok(record, '/effort medium')).toEqual({
      changed: true,
      opensAgentPicker: false
    })
    expect(record.valuesByModel['grok-4.5']?.effort).toEqual({
      value: 'medium',
      source: 'dispatched'
    })
  })

  it('tracks nothing for an effort tier outside the seeded choices', () => {
    // grok accepts `xhigh`, but the picker only offers values the shared labels
    // localize, so tracking it would render an untranslated pill.
    const record = grokRecord('grok-4.5')
    recordGrok(record, '/effort xhigh')
    expect(record.valuesByModel['grok-4.5']?.effort).toBeUndefined()
  })

  it('rejects grok’s two-argument /model form and any other prose', () => {
    // `/model Reasoning X high` is real grok syntax; whitespace means we cannot
    // tell a model id from a prompt, so track nothing rather than guess.
    const record = grokRecord('grok-4.5')
    expect(recordGrok(record, '/model Reasoning X high')).toEqual({
      changed: false,
      opensAgentPicker: false
    })
    expect(record.model).toEqual({ value: 'grok-4.5', source: 'dispatched' })
  })

  it('does not open an agent picker for a bare /model', () => {
    const record = grokRecord('grok-4.5')
    expect(recordGrok(record, '/model')).toEqual({ changed: false, opensAgentPicker: false })
    expect(record.model).toEqual({ value: 'grok-4.5', source: 'dispatched' })
  })

  it('tracks a typed effort under the CLI default when no model was picked', () => {
    // Regression: the picker draws the effort row under grok's own default, so reading
    // the tracked model alone dropped the very command that row's pill reports on —
    // leaving it `unknown` right after the user set it.
    const record = grokRecord()
    const persist = vi.fn()
    expect(
      recordNativeChatSessionOptionCommand({
        catalog: GROK_SESSION_OPTION_CATALOG,
        models: GROK_SESSION_OPTION_CATALOG.models,
        record,
        command: '/effort low',
        persist
      })
    ).toEqual({ changed: true, opensAgentPicker: false })
    expect(record.valuesByModel['grok-4.5']?.effort).toEqual({
      value: 'low',
      source: 'dispatched'
    })
    expect(persist).toHaveBeenCalledWith('grok-4.5', 'effort', 'low')
  })

  it('does not reset tracked state when the typed model is the CLI default already shown', () => {
    // Regression: an untracked record read as `null`, so re-typing the model the picker
    // already displays looked like a switch and deleted that model's options.
    const record = grokRecord()
    recordGrok(record, '/effort low')
    recordGrok(record, '/model grok-4.5')
    expect(record.valuesByModel['grok-4.5']?.effort).toEqual({
      value: 'low',
      source: 'dispatched'
    })
  })

  it('still resets tracked state when the typed model is a real switch', () => {
    const record = grokRecord()
    recordGrok(record, '/effort low')
    recordNativeChatSessionOptionCommand({
      catalog: GROK_SESSION_OPTION_CATALOG,
      models: [
        ...GROK_SESSION_OPTION_CATALOG.models,
        { id: 'grok-build', label: 'Grok Build', options: [] }
      ],
      record,
      command: '/model grok-build'
    })
    expect(record.model).toEqual({ value: 'grok-build', source: 'dispatched' })
    expect(record.valuesByModel['grok-4.5']?.effort).toEqual({
      value: 'low',
      source: 'dispatched'
    })
  })

  it('still tracks a model the discovered list dropped', () => {
    const record = grokRecord()
    recordNativeChatSessionOptionCommand({
      catalog: GROK_SESSION_OPTION_CATALOG,
      models: [{ id: 'grok-build', label: 'Grok Build', options: [] }],
      record,
      command: '/model grok-4.5'
    })
    expect(record.model).toEqual({ value: 'grok-4.5', source: 'dispatched' })
  })
})
