import type { SessionOptionDescriptor } from './native-chat-session-options'

export const STRUCTURED_MACHINE_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'omp'] as const
export const DEFAULT_ENABLED_STRUCTURED_MACHINE_AGENTS = ['codex'] as const
export type StructuredMachineAgent = (typeof STRUCTURED_MACHINE_AGENTS)[number]

export function isStructuredMachineAgent(agent: string): agent is StructuredMachineAgent {
  return (STRUCTURED_MACHINE_AGENTS as readonly string[]).includes(agent)
}

export function normalizeEnabledStructuredMachineAgents(value: unknown): StructuredMachineAgent[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ENABLED_STRUCTURED_MACHINE_AGENTS]
  }
  const enabled = new Set(value)
  return STRUCTURED_MACHINE_AGENTS.filter((agent) => enabled.has(agent))
}

export function isStructuredMachineAgentEnabled(
  agent: unknown,
  enabled: unknown
): agent is StructuredMachineAgent {
  return (
    typeof agent === 'string' &&
    (normalizeEnabledStructuredMachineAgents(enabled) as readonly string[]).includes(agent)
  )
}

export type StructuredProviderPermission = {
  id: string
  itemId?: string
  revision?: number
  title: string
  detail?: string
  options: { id: string; label: string; kind: 'allow-once' | 'allow-always' | 'reject' }[]
}

export type StructuredProviderInput = {
  questionGroup?: boolean
  id: string
  itemId?: string
  revision?: number
  questions: {
    id: string
    header: string
    question: string
    options?: { id?: string; label: string; description?: string }[]
    allowOther?: boolean
    secret?: boolean
    multiSelect?: boolean
  }[]
}

export type StructuredProviderConfiguration = {
  commands: { name: string; description?: string; inputHint?: string }[]
  options: SessionOptionDescriptor[]
  canCompact: boolean
  canFork: boolean
  canSteer?: boolean
}
