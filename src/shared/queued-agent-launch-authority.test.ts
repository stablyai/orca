import { describe, expect, it } from 'vitest'
import { attachQueuedAgentLaunchAuthority } from './queued-agent-launch-authority'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('attachQueuedAgentLaunchAuthority', () => {
  it('stamps a bare cursor-agent command with launch config and a launch token', () => {
    const stamped = attachQueuedAgentLaunchAuthority({ command: 'cursor-agent' })
    expect(stamped.launchAgent).toBe('cursor')
    expect(stamped.launchConfig).toEqual({
      agentCommand: 'cursor-agent',
      agentArgs: '',
      agentEnv: {}
    })
    expect(stamped.launchToken).toMatch(UUID_RE)
    expect(stamped.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe(stamped.launchToken)
  })

  it('leaves a plain shell command tokenless', () => {
    expect(attachQueuedAgentLaunchAuthority({ command: 'echo hi' })).toEqual({ command: 'echo hi' })
  })

  it('does not mint authority for a non-bare agent invocation', () => {
    expect(attachQueuedAgentLaunchAuthority({ command: 'codex exec summarize' })).toEqual({
      command: 'codex exec summarize'
    })
    expect(attachQueuedAgentLaunchAuthority({ command: 'cursor-agent --foo' })).toEqual({
      command: 'cursor-agent --foo'
    })
  })

  it('does not mint a token for an unrecognized command even when launchConfig is present', () => {
    expect(
      attachQueuedAgentLaunchAuthority({
        command: 'echo hi',
        launchConfig: { agentArgs: '', agentEnv: {} }
      })
    ).toEqual({
      command: 'echo hi',
      launchConfig: { agentArgs: '', agentEnv: {} }
    })
  })

  it('stamps a non-bare invocation when launchConfig is already present', () => {
    const stamped = attachQueuedAgentLaunchAuthority({
      command: 'codex exec summarize',
      launchConfig: { agentCommand: 'codex exec summarize', agentArgs: '', agentEnv: {} }
    })
    expect(stamped.launchAgent).toBe('codex')
    expect(stamped.launchToken).toMatch(UUID_RE)
    expect(stamped.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe(stamped.launchToken)
  })

  it('overwrites a captured ORCA_AGENT_LAUNCH_TOKEN with the minted token', () => {
    const stamped = attachQueuedAgentLaunchAuthority({
      command: 'codex resume sess-1',
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: 'codex',
        agentArgs: '',
        agentEnv: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'stale-token' }
      },
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'stale-token' }
    })
    expect(stamped.launchToken).toMatch(UUID_RE)
    expect(stamped.launchToken).not.toBe('stale-token')
    expect(stamped.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe(stamped.launchToken)
    expect(stamped.env?.CODEX_PROFILE).toBe('captured')
  })

  it('mints a distinct token per call so a sibling cannot inherit authority', () => {
    const first = attachQueuedAgentLaunchAuthority({ command: 'cursor-agent' })
    const second = attachQueuedAgentLaunchAuthority({ command: 'cursor-agent' })
    expect(first.launchToken).toMatch(UUID_RE)
    expect(second.launchToken).toMatch(UUID_RE)
    expect(first.launchToken).not.toBe(second.launchToken)
    expect(first.env?.ORCA_AGENT_LAUNCH_TOKEN).not.toBe(second.env?.ORCA_AGENT_LAUNCH_TOKEN)
  })

  it('reuses an explicit launch token instead of minting another', () => {
    const stamped = attachQueuedAgentLaunchAuthority({
      command: 'cursor-agent',
      launchToken: 'explicit-token'
    })
    expect(stamped.launchToken).toBe('explicit-token')
    expect(stamped.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe('explicit-token')
  })
})
