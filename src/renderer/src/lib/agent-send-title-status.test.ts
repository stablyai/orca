import { describe, expect, it } from 'vitest'
import { detectAgentSendTitleStatus } from './agent-send-title-status'

describe('detectAgentSendTitleStatus', () => {
  it.each([
    'OC | Native session',
    'OC | ✦ Gemini CLI',
    'OC | ✋ review Gemini permission handling',
    'ssh build-host | OC | Native session',
    'user@host: ~/code | OC | Native session',
    '▣ OC | Native session',
    'OC |   Native session',
    'OC |\tNative session'
  ])('accepts OpenCode native idle title %j', (title) => {
    expect(detectAgentSendTitleStatus(title)).toBe('idle')
  })

  it('preserves spinner working state for OpenCode', () => {
    expect(detectAgentSendTitleStatus('⠋ OC | Native session')).toBe('working')
    expect(detectAgentSendTitleStatus('ssh build-host | ⠋ OC | Native session')).toBe('working')
  })

  it.each(['OC |', 'OC |Native session', 'oc | Native session', 'OCTOPUS | Native session'])(
    'rejects incomplete or lookalike OpenCode title %j',
    (title) => {
      expect(detectAgentSendTitleStatus(title)).toBeNull()
    }
  )

  it('preserves non-OpenCode title behavior', () => {
    expect(detectAgentSendTitleStatus('✦ Gemini CLI')).toBe('working')
    expect(detectAgentSendTitleStatus('Codex ready')).toBe('idle')
    expect(detectAgentSendTitleStatus('zsh')).toBeNull()
  })
})
