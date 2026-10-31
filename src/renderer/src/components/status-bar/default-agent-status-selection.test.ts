import { describe, expect, it } from 'vitest'
import {
  listSelectableDefaultAgents,
  resolveDefaultAgentSelection,
  resolveDefaultAgentTriggerLabel
} from './default-agent-status-selection'

const catalog = [
  { id: 'claude' as const, label: 'Claude' },
  { id: 'codex' as const, label: 'Codex' },
  { id: 'gemini' as const, label: 'Gemini' }
]

describe('resolveDefaultAgentSelection', () => {
  it('treats blank as an explicit no-agent choice', () => {
    expect(
      resolveDefaultAgentSelection({
        defaultAgent: 'blank',
        detectedIds: new Set(['claude']),
        disabledAgents: []
      })
    ).toEqual({ kind: 'blank', agentId: null })
  })

  it('uses Auto when the default is unset', () => {
    expect(
      resolveDefaultAgentSelection({
        defaultAgent: null,
        detectedIds: new Set(['claude']),
        disabledAgents: []
      })
    ).toEqual({ kind: 'auto', agentId: null })
  })

  it('falls back to Auto when the chosen agent is missing from PATH', () => {
    expect(
      resolveDefaultAgentSelection({
        defaultAgent: 'codex',
        detectedIds: new Set(['claude']),
        disabledAgents: []
      })
    ).toEqual({ kind: 'auto', agentId: null })
  })

  it('falls back to Auto when the chosen agent is disabled', () => {
    expect(
      resolveDefaultAgentSelection({
        defaultAgent: 'codex',
        detectedIds: new Set(['codex', 'claude']),
        disabledAgents: ['codex']
      })
    ).toEqual({ kind: 'auto', agentId: null })
  })

  it('keeps a detected enabled agent as the explicit default', () => {
    expect(
      resolveDefaultAgentSelection({
        defaultAgent: 'codex',
        detectedIds: new Set(['codex', 'claude']),
        disabledAgents: []
      })
    ).toEqual({ kind: 'agent', agentId: 'codex' })
  })

  it('does not flash Auto while detection is still in flight', () => {
    // Why: null detection means "unknown", not "missing" — preserve the stored pick.
    expect(
      resolveDefaultAgentSelection({
        defaultAgent: 'codex',
        detectedIds: null,
        disabledAgents: []
      })
    ).toEqual({ kind: 'agent', agentId: 'codex' })
  })
})

describe('listSelectableDefaultAgents', () => {
  it('returns nothing while detection is pending', () => {
    expect(
      listSelectableDefaultAgents({
        catalog,
        detectedIds: null,
        disabledAgents: []
      })
    ).toEqual([])
  })

  it('filters to enabled detected agents in catalog order', () => {
    expect(
      listSelectableDefaultAgents({
        catalog,
        detectedIds: new Set(['gemini', 'claude']),
        disabledAgents: ['gemini']
      })
    ).toEqual([{ id: 'claude', label: 'Claude' }])
  })
})

describe('resolveDefaultAgentTriggerLabel', () => {
  it('labels Auto and blank distinctly from a named agent', () => {
    expect(
      resolveDefaultAgentTriggerLabel({
        selection: { kind: 'auto', agentId: null },
        agentLabel: 'Codex',
        autoLabel: 'Auto',
        blankLabel: 'Blank'
      })
    ).toBe('Auto')
    expect(
      resolveDefaultAgentTriggerLabel({
        selection: { kind: 'blank', agentId: null },
        agentLabel: 'Codex',
        autoLabel: 'Auto',
        blankLabel: 'Blank'
      })
    ).toBe('Blank')
    expect(
      resolveDefaultAgentTriggerLabel({
        selection: { kind: 'agent', agentId: 'codex' },
        agentLabel: 'Codex',
        autoLabel: 'Auto',
        blankLabel: 'Blank'
      })
    ).toBe('Codex')
  })
})
