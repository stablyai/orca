export type AgentSessionMcpAction =
  | { action: 'status' }
  | { action: 'authenticate'; server: string }
  | { action: 'reconnect'; server: string }
  | { action: 'toggle'; server: string; enabled: boolean }

export type AgentSessionMcpServer = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  canAuthenticate: boolean
}

export type AgentSessionMcpResult =
  | { status: 'ok'; servers: AgentSessionMcpServer[] }
  | { status: 'unavailable' | 'busy' | 'failed' | 'session-changed' }
