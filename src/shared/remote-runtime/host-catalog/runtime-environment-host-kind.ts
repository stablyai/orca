import type { OrcadDeploymentLink, RuntimeSshTunnelLink } from './runtime-environments'
import type { OrcadWslDeploymentLink } from './wsl-host-deployment-link'

/** Switch exhaustively on kind: ssh is reached through an SSH tunnel; wsl uses this computer’s wsl.exe bridge. */
export type RuntimeEnvironmentHost<T> =
  | { kind: 'network'; environment: T }
  | { kind: 'ssh'; environment: T }
  | { kind: 'wsl'; environment: T; deployment: OrcadWslDeploymentLink }

export function classifyRuntimeEnvironmentHost<
  T extends {
    orcadDeployment?: OrcadDeploymentLink | null
    sshAccess?: RuntimeSshTunnelLink | null
  }
>(environment: T): RuntimeEnvironmentHost<T> {
  const deployment = environment.orcadDeployment
  if (!deployment) {
    return environment.sshAccess ? { kind: 'ssh', environment } : { kind: 'network', environment }
  }
  switch (deployment.kind) {
    // Why undefined: SSH deployment links are persisted without their kind.
    case undefined:
    case 'ssh':
      return { kind: 'ssh', environment }
    case 'wsl':
      return { kind: 'wsl', environment, deployment }
  }
}
