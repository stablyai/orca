/**
 * P0-1 Agent Identity Registry
 *
 * Types and interfaces for agent session identity registration and discovery.
 * Allows each agent session running in Orca to register itself with identity,
 * declared capabilities, and activity tracking for cross-session coordination.
 */

/**
 * A capability method that an agent declares it can handle.
 * Format: "namespace.method" (e.g., "terminal.ensureAgentSession", "file.read")
 */
export type CapabilityMethod = string & { readonly __brand: 'CapabilityMethod' }

export function brandCapabilityMethod(method: string): CapabilityMethod {
  return method as CapabilityMethod
}

/**
 * Declared capabilities of an agent session.
 * This is a snapshot of what the agent claims to support.
 */
export type AgentCapabilityDeclaration = {
  /**
   * The keyId of the agent that made this declaration.
   */
  agentKeyId: string

  /**
   * List of RPC methods this agent declares it can handle.
   * Format: "namespace.method"
   */
  supportedMethods: CapabilityMethod[]

  /**
   * SHA256 digest of the serialized supportedMethods array for integrity verification.
   * Format: base64url encoded.
   */
  capabilityDigest: string

  /**
   * Timestamp (milliseconds since epoch) when capabilities were declared.
   */
  declaredAt: number

  /**
   * Timestamp (milliseconds since epoch) when capabilities expire if not refreshed.
   * Used for graceful degradation if an agent disappears.
   */
  expiresAt: number
}

/**
 * Live agent session information in the registry.
 * This is maintained in memory for the lifetime of the agent session.
 */
export type LiveAgentInfo = {
  /**
   * Unique identifier for this agent session.
   * Derived from SHA256(coordinationKey).slice(0, 22) in base64url.
   */
  keyId: string

  /**
   * Type of agent (e.g., "pi", "prime-agent", "codex", etc.).
   * Comes from the agent session identity.
   */
  agentType: string

  /**
   * Unique session ID for this agent instance.
   * Used to distinguish between multiple running instances of the same agent type.
   */
  sessionId: string

  /**
   * Declared capabilities of this agent session.
   */
  capabilities: AgentCapabilityDeclaration

  /**
   * Timestamp (milliseconds since epoch) of the last heartbeat from this agent.
   * Used for TTL-based expiration (60 seconds).
   */
  lastActivityAt: number

  /**
   * Optional metadata about the agent.
   * Could include worktree info, connection details, or custom fields.
   */
  metadata?: Record<string, unknown>
}

/**
 * Request to register an agent in the registry.
 */
export type AgentRegistryRequest = {
  /**
   * Unique keyId for the agent (from coordination key).
   */
  keyId: string

  /**
   * Type of agent (e.g., "pi", "prime-agent").
   */
  agentType: string

  /**
   * Unique session ID for this instance.
   */
  sessionId: string

  /**
   * Methods this agent declares it can handle.
   */
  supportedMethods: CapabilityMethod[]

  /**
   * Optional metadata about the agent.
   */
  metadata?: Record<string, unknown>
}

/**
 * Options for querying agents from the registry.
 */
export type AgentRegistryListOptions = {
  /**
   * Filter results by agent type (e.g., "pi", "prime-agent").
   * If not specified, returns all agents.
   */
  agentType?: string

  /**
   * Filter results by a capability method.
   * Only returns agents that support this method.
   */
  capability?: CapabilityMethod
}

/**
 * Result of a registry list query.
 */
export type AgentRegistryListResult = {
  /**
   * The agents matching the query criteria.
   */
  agents: LiveAgentInfo[]

  /**
   * Total number of agents currently registered (before filtering).
   */
  totalCount: number
}

/**
 * TTL configuration for agent registry entries.
 */
export const AGENT_REGISTRY_CONFIG = {
  /**
   * How long (in milliseconds) an agent entry remains valid without a heartbeat.
   */
  TTL_MS: 60 * 1000, // 60 seconds

  /**
   * How long a capability declaration is valid.
   * Set to twice the TTL to allow for some graceful degradation time.
   */
  CAPABILITY_TTL_MS: 120 * 1000 // 120 seconds
} as const
