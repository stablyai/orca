import type { RuntimePortForward } from '../../../../../shared/runtime-port-forwards'
import type { WorkspacePort } from '../../../../../shared/workspace/ports/workspace-ports'
import { shouldShowCenteredPortsEmpty } from './local-workspace-port-sections'

/**
 * A remote host's forwards whose port the scan no longer lists, and whether the panel says
 * "no ports" centered (no group, no forwards, no host footer such as Orca Cloud's shared links).
 */
export function remotePortsPanelLayout(
  scan: { ports: WorkspacePort[]; unavailableReason?: string } | null,
  runtimeForwarding: { forwards: RuntimePortForward[] } | null,
  hasFooter: boolean,
  sections: {
    activePorts: WorkspacePort[]
    otherWorkspacePorts: WorkspacePort[]
    externalPorts: WorkspacePort[]
  }
): { remoteOnlyForwards: RuntimePortForward[]; showCenteredEmpty: boolean } {
  const remoteOnlyForwards =
    runtimeForwarding?.forwards.filter(
      (forward) => !scan?.ports.some((port) => port.port === forward.remotePort)
    ) ?? []
  return {
    remoteOnlyForwards,
    showCenteredEmpty: shouldShowCenteredPortsEmpty(scan, {
      ...sections,
      remoteOnlyForwards,
      hasFooter
    })
  }
}
