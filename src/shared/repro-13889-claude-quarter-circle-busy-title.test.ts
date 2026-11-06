import { describe, expect, it } from 'vitest'

import { createAgentStatusTracker } from './agent-status/title/agent-title-status'

const CAPTURED_2_1_228_TURN = [
  '✳ Claude Code',
  '◐ Claude Code',
  '◑ Claude Code',
  '◑ Say hi in one word',
  '◐ Say hi in one word',
  '✳ Say hi in one word'
] as const

function trackTurn(titles: readonly string[]): string[] {
  const events: string[] = []
  const tracker = createAgentStatusTracker(
    () => events.push('idle'),
    () => events.push('working'),
    () => events.push('exited')
  )
  for (const title of titles) {
    tracker.handleTitle(title)
  }
  return events
}

describe('Claude Code quarter-circle busy titles (#13889)', () => {
  it('never confirms an agent exit across a real 2.1.228 turn', () => {
    const events = trackTurn(CAPTURED_2_1_228_TURN)
    expect(events).not.toContain('exited')
    expect(events).toEqual(['working', 'idle'])
  })
})
