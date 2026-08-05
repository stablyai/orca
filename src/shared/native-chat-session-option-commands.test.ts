import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
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

  it('has no absolute command for agent-picker applies (Codex model)', () => {
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
