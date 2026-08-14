import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_ROW_DISPLAY_FIELDS,
  agentRowShowsField,
  normalizeAgentRowDisplayFields
} from './agent-row-display-fields'

describe('normalizeAgentRowDisplayFields', () => {
  it('defaults to every field when absent', () => {
    expect(normalizeAgentRowDisplayFields(undefined)).toEqual(DEFAULT_AGENT_ROW_DISPLAY_FIELDS)
    expect(normalizeAgentRowDisplayFields(null)).toEqual(DEFAULT_AGENT_ROW_DISPLAY_FIELDS)
  })

  it('drops unknown entries and preserves canonical order', () => {
    expect(
      normalizeAgentRowDisplayFields(['model', 'bogus', 'provider-icon', 'model', 'relative-time'])
    ).toEqual(['provider-icon', 'model', 'relative-time'])
  })

  it('allows an empty selection', () => {
    expect(normalizeAgentRowDisplayFields([])).toEqual([])
  })

  it('defaults when the persisted value is not an array', () => {
    expect(normalizeAgentRowDisplayFields({ model: true } as never)).toEqual(
      DEFAULT_AGENT_ROW_DISPLAY_FIELDS
    )
    expect(normalizeAgentRowDisplayFields('model' as never)).toEqual(
      DEFAULT_AGENT_ROW_DISPLAY_FIELDS
    )
  })
})

describe('agentRowShowsField', () => {
  it('reports membership', () => {
    expect(agentRowShowsField(['model'], 'model')).toBe(true)
    expect(agentRowShowsField(['model'], 'provider-icon')).toBe(false)
  })
})
