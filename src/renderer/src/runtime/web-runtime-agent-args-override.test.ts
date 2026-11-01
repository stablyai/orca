import { describe, expect, it } from 'vitest'
import { webRuntimeAgentArgsOverride } from './web-runtime-agent-args-override'

describe('webRuntimeAgentArgsOverride', () => {
  it('lets a fresh launch inherit the host permission instead of the client-resolved empty args', () => {
    expect(
      webRuntimeAgentArgsOverride({ agentSessionKind: 'fresh', launchConfig: { agentArgs: '' } })
    ).toBeUndefined()
  })

  it('keeps an explicit caller override, including no arguments', () => {
    expect(webRuntimeAgentArgsOverride({ agentArgs: '', agentSessionKind: 'fresh' })).toBe('')
    expect(webRuntimeAgentArgsOverride({ agentArgs: null })).toBeNull()
  })

  it('replays the recorded recipe on resume', () => {
    expect(
      webRuntimeAgentArgsOverride({
        agentSessionKind: 'resume',
        launchConfig: { agentArgs: '--dangerously-skip-permissions' }
      })
    ).toBe('--dangerously-skip-permissions')
  })
})
