import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-status'

describe('detectAgentStatusFromTitle', () => {
  it('detects permission requests from agent titles', () => {
    expect(detectAgentStatusFromTitle('Claude Code - action required')).toBe('permission')
  })

  it('treats braille spinners as working and Gemini symbols as idle', () => {
    expect(detectAgentStatusFromTitle('⠋ Codex is thinking')).toBe('working')
    expect(detectAgentStatusFromTitle('◇ Gemini CLI')).toBe('idle')
  })
})
