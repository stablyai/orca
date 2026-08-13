import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { getAgentLabel, isClaudeAgent } from './agent-title-identity'
import { resolveTerminalTitleAgentType } from './terminal-title-agent-type'

// The two OSC titles the Bullet CLI emits: a single braille frame while a turn
// runs, and "bullet ready" between turns. Neither is animated, so no
// normalizeTerminalTitle collapse is needed.
const BULLET_WORKING = '\u280b bullet'
const BULLET_IDLE = 'bullet ready'

describe('Bullet terminal titles', () => {
  it('maps its working and idle titles onto agent status', () => {
    expect(detectAgentStatusFromTitle(BULLET_WORKING)).toBe('working')
    expect(detectAgentStatusFromTitle(BULLET_IDLE)).toBe('idle')
  })

  it('resolves to Bullet, not Claude, on the shared braille frame', () => {
    expect(getAgentLabel(BULLET_WORKING)).toBe('Bullet')
    expect(getAgentLabel(BULLET_IDLE)).toBe('Bullet')
    expect(isClaudeAgent(BULLET_WORKING)).toBe(false)
    expect(resolveTerminalTitleAgentType(BULLET_WORKING)).toBe('bullet')
  })

  it('token-matches the name so cwd and task titles do not mint a Bullet tab', () => {
    expect(getAgentLabel('~/bullet-journal')).toBeNull()
    expect(getAgentLabel('bulletproof')).toBeNull()
  })
})
