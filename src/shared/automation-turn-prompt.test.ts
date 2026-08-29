import { describe, expect, it } from 'vitest'
import { normalizePromptField } from './agent-status-field-normalization'
import {
  buildAutomationTurnPrompt,
  isAutomationTurnPrompt,
  stripAutomationTurnMarker,
  stripAutomationTurnMarkerFromPublishedStatus
} from './automation-turn-prompt'

describe('automation turn prompts', () => {
  it('gives identical task text distinct authority-owned turn identities', () => {
    const first = buildAutomationTurnPrompt('run this', 'run-1')
    const second = buildAutomationTurnPrompt('run this', 'run-2')

    expect(first).not.toBe(second)
    expect(isAutomationTurnPrompt(first)).toBe(true)
    expect(isAutomationTurnPrompt(second)).toBe(true)
    expect(isAutomationTurnPrompt(first, 'run-1')).toBe(true)
    expect(isAutomationTurnPrompt(first, 'run-2')).toBe(false)
    expect(isAutomationTurnPrompt(normalizePromptField(first))).toBe(true)
    expect(isAutomationTurnPrompt('run this')).toBe(false)
  })

  it('does not trust a legacy user-authored marker for another run', () => {
    const legacyPrompt = '<!-- ORCA_AUTOMATION_RUN_ID:not-authority -->\nlegacy task'

    expect(isAutomationTurnPrompt(normalizePromptField(legacyPrompt), 'real-run-id')).toBe(false)
  })

  it('recovers the exact user task body from a marker prompt, raw or normalized', () => {
    const raw = buildAutomationTurnPrompt('run this', 'run-1')

    expect(stripAutomationTurnMarker(raw)).toBe('run this')
    expect(stripAutomationTurnMarker(normalizePromptField(raw))).toBe('run this')
    expect(stripAutomationTurnMarker(buildAutomationTurnPrompt('', 'run-1'))).toBe('')
  })

  // The same PR removed the dispatchPromptPreview backfill, so rows written by an older
  // build carry no marker. Publication must return that content byte-for-byte.
  it('returns pre-marker and malformed-marker text unchanged', () => {
    for (const prompt of [
      'run this',
      '',
      '<!-- ORCA_AUTOMATION_RUN_ID:run-1 -->',
      '<!-- ORCA_AUTOMATION_RUN_ID: -->\nrun this',
      'prefix <!-- ORCA_AUTOMATION_RUN_ID:run-1 --> run this'
    ]) {
      expect(stripAutomationTurnMarker(prompt)).toBe(prompt)
    }
  })

  // Strip and identity must never disagree about what a marker is.
  it('strips exactly the prompts identity matching recognizes', () => {
    for (const prompt of [
      buildAutomationTurnPrompt('run this', 'run-1'),
      normalizePromptField(buildAutomationTurnPrompt('run this', 'run-1')),
      'run this',
      '<!-- ORCA_AUTOMATION_RUN_ID:run-1 -->',
      'prefix <!-- ORCA_AUTOMATION_RUN_ID:run-1 --> run this'
    ]) {
      expect(stripAutomationTurnMarker(prompt) !== prompt).toBe(isAutomationTurnPrompt(prompt))
    }
  })

  it('strips a published status row and every turn in its history', () => {
    const marked = normalizePromptField(buildAutomationTurnPrompt('run this', 'run-1'))
    const status = {
      state: 'working' as const,
      prompt: marked,
      stateHistory: [
        { state: 'done' as const, prompt: marked, startedAt: 1 },
        { state: 'working' as const, prompt: 'legacy turn', startedAt: 0 }
      ]
    }

    expect(stripAutomationTurnMarkerFromPublishedStatus(status)).toEqual({
      state: 'working',
      prompt: 'run this',
      stateHistory: [
        { state: 'done', prompt: 'run this', startedAt: 1 },
        { state: 'working', prompt: 'legacy turn', startedAt: 0 }
      ]
    })
  })

  it('returns the same row object when nothing carries a marker', () => {
    const status = { prompt: 'run this', stateHistory: [{ prompt: 'earlier', startedAt: 0 }] }

    expect(stripAutomationTurnMarkerFromPublishedStatus(status)).toBe(status)
  })
})
