import { describe, expect, it } from 'vitest'
import { agentVerdictStatusLine } from './agent-verdict-status-line'

const FAILED = {
  state: 'done' as const,
  mainAgent: { state: 'done' as const, outcome: 'failure' as const }
}

describe('agentVerdictStatusLine', () => {
  it('names a failed program with its own message', () => {
    expect(
      agentVerdictStatusLine({
        ...FAILED,
        agentType: 'rsync',
        lastAssistantMessage: 'rsync failed',
        programStatus: { state: 'error', message: 'rsync failed', observedAt: 1 }
      })
    ).toBe('Failed: rsync failed')
  })

  it('falls back to the facet message on a program row without an assistant message', () => {
    expect(
      agentVerdictStatusLine({
        ...FAILED,
        agentType: 'brew',
        programStatus: { state: 'error', message: 'Download failed', observedAt: 1 }
      })
    ).toBe('Failed: Download failed')
  })

  it('reads plainly failed for a program with no message', () => {
    expect(
      agentVerdictStatusLine({
        ...FAILED,
        agentType: 'brew',
        programStatus: { state: 'error', observedAt: 1 }
      })
    ).toBe('Failed')
  })

  it('keeps an agent failure plain even with a last reply', () => {
    expect(
      agentVerdictStatusLine({
        ...FAILED,
        agentType: 'claude',
        lastAssistantMessage: 'I could not finish.'
      })
    ).toBe('Failed')
  })

  it('keeps a non-agent row without OSC 7501 provenance plain', () => {
    expect(agentVerdictStatusLine({ ...FAILED, lastAssistantMessage: 'oops' })).toBe('Failed')
  })

  it('reads a cancellation as interrupted by user', () => {
    expect(agentVerdictStatusLine({ state: 'done', interrupted: true })).toBe('Interrupted by user')
  })
})
