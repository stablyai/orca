/** The chat's agent connects these MCP servers; the `/mcp` panel lists and manages them. */
export type AgentSessionMcpServerStatus =
  | 'connected'
  | 'pending'
  | 'needs-auth'
  | 'failed'
  | 'disabled'

export type AgentSessionMcpServer = {
  name: string
  status: AgentSessionMcpServerStatus
  /** Where the agent found the server, e.g. claudeai, project, user, local, plugin; null when unknown. */
  source: string | null
  toolCount: number | null
  /** Short reason for a failed server, as the agent reported it. */
  error: string | null
  canSignIn: boolean
  canReconnect: boolean
  canToggle: boolean
}

export type AgentSessionMcpOperation =
  | { action: 'status' }
  | { action: 'signIn'; server: string }
  /** The address the browser landed on after sign-in, for an agent the browser can't reach. */
  | { action: 'finishSignIn'; server: string; callbackUrl: string }
  | { action: 'reconnect'; server: string }
  | { action: 'toggle'; server: string; enabled: boolean }

export type AgentSessionMcpSignIn = {
  server: string
  url: string
  /**
   * `callback`: the agent waits for the browser to come back to it; a browser on another device
   * pastes that address instead. `external`: the provider's own site finishes it, then reconnect.
   */
  finish: 'callback' | 'external'
}

export type AgentSessionMcpResult =
  | { status: 'ok'; servers: AgentSessionMcpServer[]; signIn?: AgentSessionMcpSignIn }
  /** The chat has no running agent; its servers connect when it next starts. */
  | { status: 'not-running' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string | null }

/** A sign-in page the client may open: providers pass on URLs from server-controlled metadata. */
export function agentSessionMcpWebUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !URL.canParse(url)) {
    return null
  }
  const { protocol } = new URL(url)
  return protocol === 'https:' || protocol === 'http:' ? url : null
}

/** Agents report free-form failures; keep one readable line. */
export function agentSessionMcpFailureMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const line = text.split('\n')[0]?.trim() ?? ''
  return line ? line.slice(0, 300) : null
}
