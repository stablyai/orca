import { describe, expect, it } from 'vitest'
import { classifyAgentLaunchReplayRefusal } from './agent-launch-replay-refusal'

describe('classifyAgentLaunchReplayRefusal', () => {
  it('keeps a replay an older host refuses as invalid params uncertain, never a definite failure', () => {
    const refused = { code: 'invalid_argument' }
    expect(classifyAgentLaunchReplayRefusal(refused, true)).toBe('unknown')
    expect(classifyAgentLaunchReplayRefusal(refused, false)).toBe('failed')
  })
})
