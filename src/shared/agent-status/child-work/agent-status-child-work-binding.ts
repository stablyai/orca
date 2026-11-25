import {
  deserializeAgentChildWorkAliasKey,
  parseAgentChildWorkAliasInput,
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput
} from './agent-status-child-work-alias'

const BINDING_PREFIX = 'agent-child-work-binding-v1:'

/** One alias may name several proven lifetimes; the binding, not the alias, is a row key. */
export function serializeAgentChildWorkBindingKey(binding: AgentChildWorkAliasInput): string {
  const { parent, provider, segmentId, kind, aliasKind, alias, childWorkId, fence } = binding
  const parsed = parseAgentChildWorkAliasInput({
    parent,
    provider,
    segmentId,
    kind,
    aliasKind,
    alias,
    childWorkId,
    fence
  })
  if (!parsed) {
    throw new Error('Invalid child-work binding')
  }
  return `${BINDING_PREFIX}${JSON.stringify([
    serializeAgentChildWorkAliasKey(parsed),
    parsed.childWorkId,
    parsed.fence.invocationId,
    parsed.fence.generation
  ])}`
}

export function deserializeAgentChildWorkBindingKey(
  value: string
): AgentChildWorkAliasInput | null {
  if (!value.startsWith(BINDING_PREFIX)) {
    return null
  }
  let tuple: unknown
  try {
    tuple = JSON.parse(value.slice(BINDING_PREFIX.length))
  } catch {
    return null
  }
  if (!Array.isArray(tuple) || tuple.length !== 4 || typeof tuple[0] !== 'string') {
    return null
  }
  const alias = deserializeAgentChildWorkAliasKey(tuple[0])
  const parsed = parseAgentChildWorkAliasInput({
    ...alias,
    childWorkId: tuple[1],
    fence: { invocationId: tuple[2], generation: tuple[3] }
  })
  return parsed && serializeAgentChildWorkBindingKey(parsed) === value ? parsed : null
}
