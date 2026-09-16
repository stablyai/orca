import {
  agentChildWorkFencesEqual,
  type AgentChildWorkId,
  type AgentChildWorkInvocationFence,
  type AgentChildWorkKind
} from './agent-status-child-work'
import { parseAgentChildWorkInvocationFence } from './agent-status-child-work-codec'
import {
  deserializeAgentStatusSubject,
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from './agent-status-subject'

const CHILD_ALIAS_KEY_PREFIX = 'agent-child-work-alias-v1:'
const MAX_ALIAS_PART_LENGTH = 512

export type AgentChildWorkAliasKind = 'task_id' | 'tool_use_id'

export type AgentChildWorkAliasIdentity = Pick<
  AgentChildWorkAliasInput,
  'parent' | 'provider' | 'segmentId' | 'kind' | 'aliasKind' | 'alias'
>

export type AgentChildWorkAliasInput = {
  parent: AgentStatusSubject
  provider: string
  segmentId: string
  kind: AgentChildWorkKind
  aliasKind: AgentChildWorkAliasKind
  alias: string
  childWorkId: AgentChildWorkId
  fence: AgentChildWorkInvocationFence
}

export type AgentChildWorkAliasRecord = AgentChildWorkAliasInput & {
  revision: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(record)
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isBoundedString(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ALIAS_PART_LENGTH ||
    value !== value.trim()
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isKind(value: unknown): value is AgentChildWorkKind {
  return (
    value === 'agent' ||
    value === 'workflow' ||
    value === 'command' ||
    value === 'monitor' ||
    value === 'unknown'
  )
}

export function parseAgentChildWorkAliasInput(value: unknown): AgentChildWorkAliasInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'parent',
      'provider',
      'segmentId',
      'kind',
      'aliasKind',
      'alias',
      'childWorkId',
      'fence'
    ]) ||
    !isBoundedString(value.provider) ||
    !isBoundedString(value.segmentId) ||
    !isKind(value.kind) ||
    (value.aliasKind !== 'task_id' && value.aliasKind !== 'tool_use_id') ||
    !isBoundedString(value.alias) ||
    !isBoundedString(value.childWorkId)
  ) {
    return null
  }
  const parent = parseAgentStatusSubject(value.parent)
  const fence = parseAgentChildWorkInvocationFence(value.fence)
  if (!parent || !fence) {
    return null
  }
  return {
    parent,
    provider: value.provider,
    segmentId: value.segmentId,
    kind: value.kind,
    aliasKind: value.aliasKind,
    alias: value.alias,
    childWorkId: value.childWorkId,
    fence
  }
}

export function parseAgentChildWorkAliasRecord(value: unknown): AgentChildWorkAliasRecord | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null
  }
  const input = { ...value }
  delete input.revision
  const parsed = parseAgentChildWorkAliasInput(input)
  return parsed ? { ...parsed, revision: value.revision } : null
}

export function serializeAgentChildWorkAliasKey(alias: AgentChildWorkAliasIdentity): string {
  const parsed = parseAgentChildWorkAliasInput({
    parent: alias.parent,
    provider: alias.provider,
    segmentId: alias.segmentId,
    kind: alias.kind,
    aliasKind: alias.aliasKind,
    alias: alias.alias,
    childWorkId: 'key-only',
    fence: { invocationId: 'key-only', generation: 0 }
  })
  if (!parsed) {
    throw new Error('Invalid agent child-work alias')
  }
  return `${CHILD_ALIAS_KEY_PREFIX}${JSON.stringify([
    serializeAgentStatusSubject(parsed.parent),
    parsed.provider,
    parsed.segmentId,
    parsed.kind,
    parsed.aliasKind,
    parsed.alias
  ])}`
}

export function deserializeAgentChildWorkAliasKey(
  value: string
): AgentChildWorkAliasIdentity | null {
  if (!value.startsWith(CHILD_ALIAS_KEY_PREFIX)) {
    return null
  }
  let tuple: unknown
  try {
    tuple = JSON.parse(value.slice(CHILD_ALIAS_KEY_PREFIX.length))
  } catch {
    return null
  }
  if (!Array.isArray(tuple) || tuple.length !== 6) {
    return null
  }
  const [parentKey, provider, segmentId, kind, aliasKind, alias] = tuple
  if (typeof parentKey !== 'string') {
    return null
  }
  const parent = deserializeAgentStatusSubject(parentKey)
  const parsed = parseAgentChildWorkAliasInput({
    parent,
    provider,
    segmentId,
    kind,
    aliasKind,
    alias,
    childWorkId: 'key-only',
    fence: { invocationId: 'key-only', generation: 0 }
  })
  if (!parsed) {
    return null
  }
  const identity = {
    parent: parsed.parent,
    provider: parsed.provider,
    segmentId: parsed.segmentId,
    kind: parsed.kind,
    aliasKind: parsed.aliasKind,
    alias: parsed.alias
  }
  return serializeAgentChildWorkAliasKey(identity) === value ? identity : null
}

export function agentChildWorkAliasesMatch(
  left: AgentChildWorkAliasInput,
  right: AgentChildWorkAliasInput
): boolean {
  return (
    serializeAgentChildWorkAliasKey(left) === serializeAgentChildWorkAliasKey(right) &&
    left.childWorkId === right.childWorkId &&
    agentChildWorkFencesEqual(left.fence, right.fence)
  )
}
