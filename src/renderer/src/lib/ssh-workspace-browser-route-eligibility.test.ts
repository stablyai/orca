import { describe, expect, it } from 'vitest'
import { resolveSshWorkspaceBrowserRouteEligibility } from './ssh-workspace-browser-route-eligibility'

const deployment = {
  sshTargetId: 'target-a',
  sshTargetGeneration: 1,
  localPort: 41000,
  remotePort: 6768
}
const managed = [{ id: 'env-a', orcadDeployment: deployment }]

describe('SSH workspace browser route eligibility', () => {
  it('keeps the same target when an SSH workspace becomes managed', () => {
    const before = resolveSshWorkspaceBrowserRouteEligibility('ssh:target-a', {})
    expect(resolveSshWorkspaceBrowserRouteEligibility('runtime:env-a', {}, managed)).toEqual({
      ...before,
      expectedSshTargetGeneration: 1
    })
    expect(before).toEqual({ targetId: 'target-a', eligible: true })
  })

  it.each([
    { browserSshWorkspaceRoutingEnabled: false },
    { browserSshWorkspaceRoutingDisabledTargetIds: ['target-a'] }
  ])('honors the existing routing opt-out after conversion: %j', (settings) => {
    expect(resolveSshWorkspaceBrowserRouteEligibility('runtime:env-a', settings, managed)).toEqual({
      targetId: 'target-a',
      eligible: false,
      expectedSshTargetGeneration: 1
    })
  })

  it('does not mistake an SSH access tunnel for the execution host', () => {
    const accessOnly = [{ id: 'env-a', sshAccess: deployment }]
    expect(resolveSshWorkspaceBrowserRouteEligibility('runtime:env-a', {}, accessOnly)).toBeNull()
  })

  it.each(['local', 'wsl:Ubuntu', 'runtime:other', 'ssh:runtime-ssh-owned'])(
    'does not borrow a managed route for %s',
    (host) => {
      expect(resolveSshWorkspaceBrowserRouteEligibility(host, {}, managed)).toBeNull()
    }
  )

  it('keeps a paired runtime-owned deployment on its owning runtime', () => {
    const nested = [
      { id: 'env-a', orcadDeployment: { ...deployment, sshTargetId: 'runtime-ssh-a' } }
    ]
    expect(resolveSshWorkspaceBrowserRouteEligibility('runtime:env-a', {}, nested)).toBeNull()
  })
})
