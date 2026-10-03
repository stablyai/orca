import { describe, expect, it } from 'vitest'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationSource
} from './agent-session-continuation'

function makeSource(
  overrides: Partial<AgentSessionContinuationSource> = {}
): AgentSessionContinuationSource {
  return {
    sourceAgent: 'claude',
    capturedText: '',
    transcriptPath: '/home/marabel/.claude/projects/orca/session.jsonl',
    ...overrides
  }
}

describe('buildAgentSessionContinuationPrompt', () => {
  it('points both context modes at the transcript path it is given', () => {
    const bridged = makeSource({ transcriptPath: '/home/marabel/.orca/handoffs/claude-abc.jsonl' })
    expect(buildAgentSessionContinuationPrompt(bridged, 'focused')).toContain(
      '/home/marabel/.orca/handoffs/claude-abc.jsonl'
    )
    expect(buildAgentSessionContinuationPrompt(bridged, 'full')).toContain(
      'Read the complete original session transcript from this path'
    )
  })

  it('names both hosts when the new session starts somewhere else', () => {
    const prompt = buildAgentSessionContinuationPrompt(
      makeSource({ hostChange: { fromLabel: 'Local Mac', toLabel: 'Hetzner VPS' } }),
      'focused'
    )
    expect(prompt).toContain('this session runs on Hetzner VPS')
    expect(prompt).toContain('the prior session ran on Local Mac')
    expect(prompt).toContain('The checkout here may differ from the transcript.')
  })

  it('omits the host line for a same-host continuation', () => {
    expect(buildAgentSessionContinuationPrompt(makeSource(), 'focused')).not.toContain('Host:')
  })

  it('explains a truncated transcript rather than calling it terminal scrollback', () => {
    const prompt = buildAgentSessionContinuationPrompt(
      makeSource({
        transcriptPath: null,
        capturedText: 'user: keep going\nassistant: on it',
        capturedTextKind: 'transcript-tail'
      }),
      'focused'
    )
    expect(prompt).toContain('too large to move to this host')
    expect(prompt).not.toContain('terminal capture')
  })

  it('still describes raw scrollback as a terminal capture', () => {
    const prompt = buildAgentSessionContinuationPrompt(
      makeSource({ transcriptPath: null, capturedText: 'some scrollback' }),
      'focused'
    )
    expect(prompt).toContain('bounded recent terminal capture')
  })

  it('refuses full mode when no transcript file reached the target host', () => {
    expect(
      buildAgentSessionContinuationPrompt(
        makeSource({
          transcriptPath: null,
          capturedText: 'user: keep going',
          capturedTextKind: 'transcript-tail'
        }),
        'full'
      )
    ).toBeNull()
  })
})
