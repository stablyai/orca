import type { OrcadManagedDeployResult } from './orcad-managed-runtime'
import type { SshRepoReadoption, SshTargetCreateInput } from './ssh-types'

export type OrcadSshProvisioningIntent = Readonly<{
  requestId: string
  name: string
}>

export type OrcadSshProvisioningRequest = OrcadSshProvisioningIntent & {
  target: SshTargetCreateInput
}

export type OrcadSshPendingProvisioning = OrcadSshProvisioningIntent & {
  sshTargetId: string
}

export type OrcadSshProvisioningResult = OrcadSshPendingProvisioning & {
  repoReadoptions: SshRepoReadoption[]
  result: OrcadManagedDeployResult | { outcome: 'pending'; reason: string }
}
