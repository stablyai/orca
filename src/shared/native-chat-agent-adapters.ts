import type { AgentType } from './agent-status-types'

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok'
export type NativeChatAskAnswerMode = 'single-submit' | 'step-lines'
export type NativeChatCommandCatalog = 'agent' | 'none'

export type NativeChatAgentAdapter = Readonly<{
  agent: AgentType
  transcriptAgent: NativeChatTranscriptAgent
  askAnswerMode: NativeChatAskAnswerMode
  skillPrefix: '$' | '/'
  groupedSlash: boolean
  skillSourceOwner: AgentType
  commandCatalog: NativeChatCommandCatalog
}>

export type NativeChatAgentAdapterRegistry = Readonly<{
  /** Returns the immutable descriptor registered for an agent, or null when unsupported. */
  get(agent: string | null | undefined): NativeChatAgentAdapter | null
  /** Returns the frozen registration-order snapshot used to derive supported-agent projections. */
  list(): readonly NativeChatAgentAdapter[]
}>

/** Clones and freezes one descriptor before it enters the public registry snapshot. */
function freezeNativeChatAgentAdapter(adapter: NativeChatAgentAdapter): NativeChatAgentAdapter {
  return Object.freeze({ ...adapter })
}

/**
 * Builds an immutable lookup registry from built-in Chat UI adapter descriptors.
 * Descriptors are snapshotted and duplicate agent ownership fails fast.
 */
export function createNativeChatAgentAdapterRegistry(
  adapters: readonly NativeChatAgentAdapter[]
): NativeChatAgentAdapterRegistry {
  const adaptersByAgent = new Map<string, NativeChatAgentAdapter>()
  const snapshot = Object.freeze(adapters.map(freezeNativeChatAgentAdapter))
  for (const adapter of snapshot) {
    if (adaptersByAgent.has(adapter.agent)) {
      throw new Error(`Duplicate native chat agent adapter: ${adapter.agent}`)
    }
    adaptersByAgent.set(adapter.agent, adapter)
  }

  /** Returns the frozen descriptor owned by an agent, or null when it is unsupported. */
  function get(agent: string | null | undefined): NativeChatAgentAdapter | null {
    return agent ? (adaptersByAgent.get(agent) ?? null) : null
  }

  /** Returns the stable frozen descriptor snapshot in registration order. */
  function list(): readonly NativeChatAgentAdapter[] {
    return snapshot
  }

  return Object.freeze({ get, list })
}

const BUILTIN_NATIVE_CHAT_AGENT_ADAPTERS = [
  {
    agent: 'claude',
    transcriptAgent: 'claude',
    askAnswerMode: 'step-lines',
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude',
    commandCatalog: 'agent'
  },
  {
    agent: 'openclaude',
    transcriptAgent: 'claude',
    askAnswerMode: 'step-lines',
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude',
    commandCatalog: 'agent'
  },
  {
    agent: 'codex',
    transcriptAgent: 'codex',
    askAnswerMode: 'step-lines',
    skillPrefix: '$',
    groupedSlash: false,
    skillSourceOwner: 'codex',
    commandCatalog: 'agent'
  },
  {
    agent: 'grok',
    transcriptAgent: 'grok',
    askAnswerMode: 'single-submit',
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'grok',
    commandCatalog: 'none'
  }
] as const satisfies readonly NativeChatAgentAdapter[]

export const NATIVE_CHAT_AGENT_ADAPTERS = createNativeChatAgentAdapterRegistry(
  BUILTIN_NATIVE_CHAT_AGENT_ADAPTERS
)
