import type { OrcadDeploymentLink } from './runtime-environments'
import type { OrcadWslDeploymentLink } from './wsl-host-deployment-link'

/**
 * What kind of host serves a runtime environment. Switch on `kind` (lint requires the switch to be
 * exhaustive), so a new kind fails the build at every switch on it.
 * `network`: reached over the network or an SSH tunnel (paired, SSH access, SSH-managed).
 * `wsl`: a distro on this computer, reached over the wsl.exe bridge.
 */
export type RuntimeEnvironmentHost<T> =
  | { kind: 'network'; environment: T }
  | { kind: 'wsl'; environment: T; deployment: OrcadWslDeploymentLink }

export function classifyRuntimeEnvironmentHost<
  T extends { orcadDeployment?: OrcadDeploymentLink | null }
>(environment: T): RuntimeEnvironmentHost<T> {
  const deployment = environment.orcadDeployment
  if (!deployment) {
    return { kind: 'network', environment }
  }
  switch (deployment.kind) {
    // Why undefined: SSH deployment links are persisted without their kind.
    case undefined:
    case 'ssh':
      return { kind: 'network', environment }
    case 'wsl':
      return { kind: 'wsl', environment, deployment }
  }
}
