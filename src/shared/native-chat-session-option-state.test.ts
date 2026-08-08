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
