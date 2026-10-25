import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import {
  applyNativeChatReportedSessionOptions,
  createNativeChatSessionOptionRecord,
  matchNativeChatCatalogModelId,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'

function claudeRecord(): NativeChatSessionOptionRecord {
  return createNativeChatSessionOptionRecord('claude')
}

describe('applyNativeChatReportedSessionOptions', () => {
  it('reports become authority and reset stale per-model values on a model change', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'dispatched' }
    record.valuesByModel.opus = { effort: { value: 'high', source: 'dispatched' } }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'opus' })).toBe(true)
    expect(record.model).toEqual({ value: 'opus', source: 'reported' })
    // A model change invalidates previously tracked values for the destination.
    expect(record.valuesByModel.opus).toEqual({})
  })

  it('promotes a dispatched guess the report confirms', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'dispatched' }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' })).toBe(true)
    expect(record.model).toEqual({ value: 'sonnet', source: 'reported' })
  })

  it('keeps locally tracked options when the reported model is unchanged', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'reported' }
    record.valuesByModel.sonnet = { effort: { value: 'high', source: 'dispatched' } }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' })).toBe(false)
    expect(record.valuesByModel.sonnet?.effort).toEqual({ value: 'high', source: 'dispatched' })
  })

  it('is a no-op when the report matches tracked state', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'reported' }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' })).toBe(false)
  })
})

describe('matchNativeChatCatalogModelId', () => {
  it.each(['gpt-6.1-sol', 'gpt-5.5-custom', 'custom/Model-v2'])(
    'keeps the exact unlisted selector %s only when requested',
    (reported) => {
      expect(matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, reported)).not.toBe(
        reported
      )
      expect(
        matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, reported, {
          allowUnlisted: true
        })
      ).toBe(reported)
    }
  )

  it('retains known labels and rejects blank or free text as unlisted selectors', () => {
    expect(
      matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, ' GPT-5.5 ', {
        allowUnlisted: true
      })
    ).toBe('gpt-5.5')
    for (const reported of ['', '  ', 'unknown model', 'unknown\nmodel']) {
      expect(
        matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, reported, {
          allowUnlisted: true
        })
      ).toBeNull()
    }
  })

  it('prefers the longest contained id and keeps catalog order for ties', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: ['a', 'abc', 'xyz'].map((id) => ({ id, label: id, options: [] }))
    }
    expect(matchNativeChatCatalogModelId(catalog, 'provider-xyz-abc')).toBe('abc')
    expect(catalog.models.map((model) => model.id)).toEqual(['a', 'abc', 'xyz'])
  })

  it('keeps the reported selector as-is for a catalog that seeds no models', () => {
    // OMP’s unseeded catalog cannot outrank its exact hook-reported provider/id selector.
    const unseeded = { ...CLAUDE_SESSION_OPTION_CATALOG, models: [] }
    expect(matchNativeChatCatalogModelId(unseeded, ' deepseek/deepseek-v4-pro ')).toBe(
      'deepseek/deepseek-v4-pro'
    )
    expect(matchNativeChatCatalogModelId(unseeded, '   ')).toBeNull()
  })

  it('matches exact ids, labels, and provider-id containment', () => {
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'sonnet')).toBe('sonnet')
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'Sonnet 5')).toBe('sonnet')
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'claude-sonnet-5')).toBe(
      'sonnet'
    )
    expect(matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, 'gpt-5.5')).toBe('gpt-5.5')
  })

  it('returns null for unrecognized reports', () => {
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'mystery-model')).toBeNull()
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, '')).toBeNull()
  })
})
