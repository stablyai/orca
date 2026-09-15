import { describe, expect, it } from 'vitest'
import { resolveSshWorkspaceBrowserRouteEligibility as resolve } from './ssh-workspace-browser-route-eligibility'

describe('SSH workspace browser transport owner', () => {
  it('routes desktop recipe VMs through their registered SSH target', () => {
    expect(resolve('ssh:runtime-ssh-orca-vm', undefined, null)).toEqual({
      targetId: 'runtime-ssh-orca-vm',
      eligible: true
    })
  })
  it('leaves paired runtime transport to its owner, even for a same-id recipe target', () => {
    expect(resolve('ssh:runtime-ssh-orca-vm', undefined, 'server-1')).toBeNull()
    expect(resolve('ssh:ordinary-host', undefined, 'server-1')).toBeNull()
  })
  it('preserves ordinary SSH routing and explicit opt-outs', () => {
    expect(resolve('ssh:host', undefined, null)?.eligible).toBe(true)
    expect(
      resolve('ssh:runtime-ssh-vm', { browserSshWorkspaceRoutingEnabled: false }, null)?.eligible
    ).toBe(false)
    expect(
      resolve(
        'ssh:runtime-ssh-vm',
        { browserSshWorkspaceRoutingDisabledTargetIds: ['runtime-ssh-vm'] },
        null
      )?.eligible
    ).toBe(false)
    expect(resolve('local', undefined, null)).toBeNull()
    expect(resolve(undefined, undefined, null)).toBeNull()
  })
})
