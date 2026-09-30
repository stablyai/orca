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

  it.each(['π > my-project', 'OMP > my-project', 'Pi > my-project'])(
    'accepts Pi/OMP state-marker idle title %j',
    (title) => {
      expect(detectAgentSendTitleStatus(title)).toBe('idle')
    }
  )

  it.each(['π : my-project', 'OMP : my-project'])('preserves Pi/OMP working state %j', (title) => {
    expect(detectAgentSendTitleStatus(title)).toBe('working')
  })

  it.each(['π ! my-project', 'OMP ! my-project'])(
    'preserves Pi/OMP permission state %j',
    (title) => {
      expect(detectAgentSendTitleStatus(title)).toBe('permission')
    }
  )
})
