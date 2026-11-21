import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-claude-codex'
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

  it('prefers an exact-case id over an earlier case-insensitive match', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: [
        { id: 'sonnet', label: 'Sonnet', options: [] },
        { id: 'Sonnet', label: 'Sonnet', options: [] }
      ]
    }
    expect(matchNativeChatCatalogModelId(catalog, 'Sonnet')).toBe('Sonnet')
  })

  it('keeps the selected provider route when a report names only the shared base id', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: [
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', options: [] },
        { id: 'provider-a/claude-sonnet-5-5', label: 'Sonnet 5.5', options: [] },
        { id: 'provider-b/claude-sonnet-5-5', label: 'Sonnet 5.5', options: [] }
      ]
    }
    expect(
      matchNativeChatCatalogModelId(catalog, 'claude-sonnet-5-5', {
        selectedId: 'provider-b/claude-sonnet-5-5'
      })
    ).toBe('provider-b/claude-sonnet-5-5')
    expect(
      matchNativeChatCatalogModelId(catalog, 'provider-a/claude-sonnet-5-5', {
        selectedId: 'provider-b/claude-sonnet-5-5'
      })
    ).toBe('provider-a/claude-sonnet-5-5')
  })

  it('keeps the selected route when the only rows share a bare label', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: [
        { id: 'provider-a/claude-sonnet-5-5', label: 'claude-sonnet-5-5', options: [] },
        { id: 'provider-b/claude-sonnet-5-5', label: 'claude-sonnet-5-5', options: [] }
      ]
    }
    expect(
      matchNativeChatCatalogModelId(catalog, 'claude-sonnet-5-5', {
        selectedId: 'provider-b/claude-sonnet-5-5'
      })
    ).toBe('provider-b/claude-sonnet-5-5')
    expect(
      matchNativeChatCatalogModelId(catalog, 'provider-a/claude-sonnet-5-5', {
        selectedId: 'provider-b/claude-sonnet-5-5'
      })
    ).toBe('provider-a/claude-sonnet-5-5')
  })

  it('keeps the selected provider route when a status report names its resolved model', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: [
        {
          id: 'claude-sonnet-5-5',
          label: 'Sonnet 5.5',
          resolvedModel: 'claude-sonnet-5-5',
          options: []
        },
        {
          id: 'provider-b/sonnet',
          label: 'Sonnet',
          resolvedModel: 'claude-sonnet-5-5',
          options: []
        },
        {
          id: 'provider-a/sonnet',
          label: 'Sonnet',
          resolvedModel: 'claude-sonnet-5-5',
          options: []
        }
      ]
    }
    expect(
      matchNativeChatCatalogModelId(catalog, 'claude-sonnet-5-5', {
        selectedId: 'provider-b/sonnet'
      })
    ).toBe('provider-b/sonnet')
    expect(
      matchNativeChatCatalogModelId(catalog, 'provider-a/sonnet', {
        selectedId: 'provider-b/sonnet'
      })
    ).toBe('provider-a/sonnet')
  })

  it('switches to the explicit route when a case-variant full id is reported', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: [
        {
          id: 'gateway/alias',
          label: 'Alias',
          resolvedModel: 'enterprise/model',
          options: []
        },
        { id: 'enterprise/model', label: 'Enterprise', options: [] }
      ]
    }
    expect(
      matchNativeChatCatalogModelId(catalog, 'Enterprise/Model', { selectedId: 'gateway/alias' })
    ).toBe('enterprise/model')
  })

  it('does not attribute a removed provider route to a different provider', () => {
    const catalog = {
      ...CLAUDE_SESSION_OPTION_CATALOG,
      models: [{ id: 'gateway/claude-sonnet-5-5', label: 'Gateway Sonnet', options: [] }]
    }
    expect(matchNativeChatCatalogModelId(catalog, 'enterprise-gateway/claude-sonnet-5-5')).not.toBe(
      'gateway/claude-sonnet-5-5'
    )
  })

  it('keeps the reported selector as-is for a catalog that seeds no models', () => {
    // OMP’s unseeded catalog cannot outrank its exact hook-reported provider/id selector.
    const unseeded = { ...CLAUDE_SESSION_OPTION_CATALOG, models: [] }
    expect(matchNativeChatCatalogModelId(unseeded, ' deepseek/deepseek-v4-pro ')).toBe(
      'deepseek/deepseek-v4-pro'
    )
    expect(matchNativeChatCatalogModelId(unseeded, '   ')).toBeNull()
  })
})
