import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { resolveSshWorkspaceBrowserRouteEligibility } from './ssh-workspace-browser-route-eligibility'

const recipeEnvironment = {
  id: 'env-recipe',
  orcadDeployment: { sshTargetId: 'runtime-ssh-vm-1', sshTargetGeneration: 7 }
}

describe('SSH workspace browser route eligibility', () => {
  it('routes an environment recipe workspace through its runtime-owned SSH host', () => {
    expect(
      resolveSshWorkspaceBrowserRouteEligibility(toRuntimeExecutionHostId('env-recipe'), {}, [
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eligibility reads only the deployment link.
        recipeEnvironment as never
      ])
    ).toEqual({ targetId: 'runtime-ssh-vm-1', expectedSshTargetGeneration: 7, eligible: true })
  })

  it('never treats a recipe VM target as a direct SSH workspace host', () => {
    expect(resolveSshWorkspaceBrowserRouteEligibility('ssh:runtime-ssh-vm-1', {})).toBeNull()
  })
})
