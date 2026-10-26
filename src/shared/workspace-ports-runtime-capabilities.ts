// Hosts without this capability have no workspacePorts.scanHost/killHost; their scan and Stop act
// only on the endpoint itself, never on a workspace's SSH host.
export const WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY =
  'workspace-ports.host-scoped.v1' as const

export const WORKSPACE_PORTS_RUNTIME_CAPABILITIES = [
  'workspace-ports.v1',
  WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY
] as const
