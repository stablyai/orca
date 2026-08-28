import { describe, expect, it } from 'vitest'
import { isAgentLaunchRemote } from './agent-launch-remote'

describe('isAgentLaunchRemote', () => {
  it('uses workspace ownership when folder workspaces have no repo row', () => {
    expect(isAgentLaunchRemote(null, 'ssh-target-1')).toBe(true)
    expect(isAgentLaunchRemote(null, null)).toBe(false)
  })

  it('keeps a resolved repo authoritative', () => {
    expect(isAgentLaunchRemote({ connectionId: null }, 'stale-ssh-target')).toBe(false)
  })
})
