import { describe, expect, it } from 'vitest'
import { getRecipeVmSshTargetForHost } from './recipe-vm-managed-host'

const deployment = (sshTargetId: string) => ({ sshTargetId })

describe('getRecipeVmSshTargetForHost', () => {
  const environments = [
    { id: 'env-vm', orcadDeployment: deployment('runtime-ssh-vm-1') },
    { id: 'env-host', orcadDeployment: deployment('ssh-builder') },
    { id: 'env-paired' }
  ]

  it("names the VM target behind a recipe VM's managed server", () => {
    expect(getRecipeVmSshTargetForHost(environments, 'runtime:env-vm')).toBe('runtime-ssh-vm-1')
  })

  it('ignores user SSH hosts, paired servers, and non-runtime hosts', () => {
    expect(getRecipeVmSshTargetForHost(environments, 'runtime:env-host')).toBeNull()
    expect(getRecipeVmSshTargetForHost(environments, 'runtime:env-paired')).toBeNull()
    expect(getRecipeVmSshTargetForHost(environments, 'ssh:runtime-ssh-vm-1')).toBeNull()
    expect(getRecipeVmSshTargetForHost(environments, null)).toBeNull()
  })
})
