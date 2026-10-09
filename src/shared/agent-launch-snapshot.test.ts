import { describe, expect, it } from 'vitest'
import { normalizeAgentLaunchSnapshot } from './agent-launch-snapshot'

describe('optional host launch snapshot compatibility', () => {
  it('tolerates missing, malformed and unsupported peer metadata', () => {
    for (const value of [
      undefined,
      null,
      {},
      { agentId: 'future-agent', effectiveAgentArgs: '' },
      { agentId: 'claude' },
      { agentId: 'codex', effectiveAgentArgs: null }
    ]) {
      expect(normalizeAgentLaunchSnapshot(value)).toBeUndefined()
    }
  })
  it('keeps exact arguments, known emptiness, and ignores future fields', () => {
    expect(
      normalizeAgentLaunchSnapshot({
        agentId: 'codex',
        effectiveAgentArgs: '',
        future: true
      })
    ).toEqual({ agentId: 'codex', effectiveAgentArgs: '' })
    expect(
      normalizeAgentLaunchSnapshot({
        agentId: 'claude',
        effectiveAgentArgs: '  --model "my model"  '
      })?.effectiveAgentArgs
    ).toBe('  --model "my model"  ')
  })
})
