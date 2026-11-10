// Hosts without this capability have no workspacePorts.scanHost/killHost; their scan and Stop act
// only on the endpoint itself, never on a workspace's SSH host.
export const WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY =
  'workspace-ports.host-scoped.v1' as const

// Hosts with this capability serve workspacePorts.forwardTunnel, which carries a client's local
// listener to a port on the host's loopback.
export const WORKSPACE_PORTS_FORWARD_TUNNEL_RUNTIME_CAPABILITY =
  'workspace-ports.forward-tunnel.v1' as const

// A forward tunnel client that attaches with this capability, and sees it echoed in the host's
// `ready` event, may send a stream's first bytes before the host's Opened (one round trip per
// new connection instead of two). Hosts without it keep the strict open-then-send ordering.
export const WORKSPACE_PORTS_FORWARD_TUNNEL_EARLY_DATA_CAPABILITY =
  'workspace-ports.forward-tunnel.early-data.v1' as const

export const WORKSPACE_PORTS_RUNTIME_CAPABILITIES = [
  'workspace-ports.v1',
  WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY,
  WORKSPACE_PORTS_FORWARD_TUNNEL_RUNTIME_CAPABILITY,
  WORKSPACE_PORTS_FORWARD_TUNNEL_EARLY_DATA_CAPABILITY
] as const
