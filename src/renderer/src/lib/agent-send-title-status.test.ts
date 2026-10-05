import { describe, expect, it } from 'vitest'
import { detectAgentSendTitleStatus } from './agent-send-title-status'

describe('detectAgentSendTitleStatus', () => {
  it.each([
    'OC | Native session',
    'OC | ✦ Gemini CLI',
    'OC | ✋ review Gemini permission handling'
  ])('accepts OpenCode native idle title %j', (title) => {
    expect(detectAgentSendTitleStatus(title)).toBe('idle')
  })

  it('preserves spinner working state for OpenCode', () => {
    expect(detectAgentSendTitleStatus('⠋ OC | Native session')).toBe('working')
    expect(detectAgentSendTitleStatus('ssh build-host | ⠋ OC | Native session')).toBe('working')
  })

  it.each(['oc | Native session'])('rejects incomplete or lookalike OpenCode title %j', (title) => {
    expect(detectAgentSendTitleStatus(title)).toBeNull()
  })

  it('preserves non-OpenCode title behavior', () => {
    expect(detectAgentSendTitleStatus('✦ Gemini CLI')).toBe('working')
    expect(detectAgentSendTitleStatus('Codex ready')).toBe('idle')
    expect(detectAgentSendTitleStatus('zsh')).toBeNull()
  })

  it.each(['\u25d1 Check package version in package.json', '\u25d3 Deploying release 4.2'])(
    'rejects a lone quarter-circle spinner title %j',
    (title) => {
      expect(detectAgentSendTitleStatus(title)).toBeNull()
    }
  )

  it('still accepts a quarter-circle frame that carries agent identity', () => {
    expect(detectAgentSendTitleStatus('\u25d0 Claude Code')).toBe('working')
  })

  it('still accepts a braille-spinner-only title, which the runtime treats as presence', () => {
    expect(detectAgentSendTitleStatus('\u2802 Deploying release 4.2')).toBe('working')
  })
})
