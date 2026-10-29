import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'

/** Where a connector conversation comes from; `dev` is the CLI that drives one without a service. */
export const CONNECTOR_SOURCES = ['slack', 'github', 'linear', 'discord', 'dev'] as const
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number]

/** How agent-facing text names where a conversation comes from. */
export const CONNECTOR_SOURCE_NAMES: Record<ConnectorSource, string> = {
  slack: 'Slack',
  github: 'GitHub',
  linear: 'Linear',
  discord: 'Discord',
  dev: 'Orca'
}

/** Terminal agents a connector may start; see `CONNECTOR_AGENTS` for why only these. */
export type ConnectorAgent = 'claude' | 'codex'

/** An outside thread's agent pane, persisted on the workspace it runs in (system-owned). */
export type ExternalConversationLink = {
  source: ConnectorSource
  externalId: string
  paneKey: string
  agent: ConnectorAgent
  /** The agent's own session as its hooks last reported it, so a closed agent can be reopened. */
  providerSession?: AgentProviderSessionMetadata
  /** The execution host whose hook row reported `providerSession`. */
  captureHostId?: ExecutionHostId
  createdAt: number
}
