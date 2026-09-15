import {
  parseAgentChildWorkAliasInput,
  parseAgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  parseAgentChildWorkInput,
  parseAgentChildWorkRecord
} from './agent-status-child-work-codec'
import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_SNAPSHOT_VERSION,
  type AgentStatusStoreMutation,
  type AgentStatusStoreSnapshot,
  type AgentStatusTombstoneEntity,
  type AgentStatusTombstoneInput,
  type AgentStatusTombstoneRecord
} from './agent-status-store-contract'
import {
  parseAgentStatusFactIdentity,
  parseAgentStatusFactInput,
  parseAgentStatusFactRecord
} from './agent-status-store-fact-codec'
import {
  parseAgentStatusParentInput,
  parseAgentStatusParentRecord
} from './agent-status-store-parent'
import { parseAgentStatusSubject } from './agent-status-subject'
import { measureUtf8ByteLength } from './utf8-byte-limits'

const MAX_EPOCH_LENGTH = 256
const MAX_TOMBSTONE_KEY_LENGTH = 32_768

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

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isWithinSerializedLimit(value: unknown): boolean {
  try {
    return !measureUtf8ByteLength(JSON.stringify(value), {
      stopAfterBytes: AGENT_STATUS_STORE_LIMITS.serializedBytes
    }).exceededLimit
  } catch {
    return false
  }
}

function isBoundedKey(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
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

export function isAgentStatusStoreEpoch(value: unknown): value is string {
  return isBoundedKey(value, MAX_EPOCH_LENGTH)
}

function isTombstoneEntity(value: unknown): value is AgentStatusTombstoneEntity {
  return value === 'parent' || value === 'child' || value === 'alias' || value === 'fact'
}

export function parseAgentStatusTombstoneInput(value: unknown): AgentStatusTombstoneInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['entity', 'key']) ||
    !isTombstoneEntity(value.entity) ||
    !isBoundedKey(value.key, MAX_TOMBSTONE_KEY_LENGTH)
  ) {
    return null
  }
  return { entity: value.entity, key: value.key }
}

export function parseAgentStatusTombstoneRecord(value: unknown): AgentStatusTombstoneRecord | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null
  }
  const input = { ...value }
  delete input.revision
  const tombstone = parseAgentStatusTombstoneInput(input)
  return tombstone ? { ...tombstone, revision: value.revision } : null
}

function parseArray<T>(
  value: unknown,
  parser: (candidate: unknown) => T | null,
  maxLength: number
): T[] | null {
  if (!Array.isArray(value) || value.length > maxLength) {
    return null
  }
  const parsed: T[] = []
  for (const candidate of value) {
    const item = parser(candidate)
    if (!item) {
      return null
    }
    parsed.push(item)
  }
  return parsed
}

function parseMutationArray<T>(
  value: unknown,
  parser: (candidate: unknown) => T | null
): T[] | null {
  return parseArray(value, parser, AGENT_STATUS_STORE_LIMITS.mutationEntries)
}

function parseStringArray(value: unknown): string[] | null {
  return parseMutationArray(value, (candidate) =>
    isBoundedKey(candidate, MAX_TOMBSTONE_KEY_LENGTH) ? candidate : null
  )
}

export function parseAgentStatusStoreMutation(value: unknown): AgentStatusStoreMutation | null {
  const optionalKeys = [
    'parent',
    'removeParent',
    'children',
    'removeChildren',
    'aliases',
    'removeAliases',
    'facts',
    'removeFacts',
    'tombstones',
    'reopenStructuredParent'
  ]
  if (
    !isWithinSerializedLimit(value) ||
    !isRecord(value) ||
    !hasOnlyKeys(value, [], optionalKeys) ||
    Object.keys(value).length === 0
  ) {
    return null
  }
  const parent = value.parent === undefined ? undefined : parseAgentStatusParentInput(value.parent)
  const removeParent =
    value.removeParent === undefined ? undefined : parseAgentStatusSubject(value.removeParent)
  const children =
    value.children === undefined
      ? undefined
      : parseMutationArray(value.children, parseAgentChildWorkInput)
  const removeChildren =
    value.removeChildren === undefined ? undefined : parseStringArray(value.removeChildren)
  const aliases =
    value.aliases === undefined
      ? undefined
      : parseMutationArray(value.aliases, parseAgentChildWorkAliasInput)
  const removeAliases =
    value.removeAliases === undefined ? undefined : parseStringArray(value.removeAliases)
  const facts =
    value.facts === undefined
      ? undefined
      : parseMutationArray(value.facts, parseAgentStatusFactInput)
  const removeFacts =
    value.removeFacts === undefined
      ? undefined
      : parseMutationArray(value.removeFacts, parseAgentStatusFactIdentity)
  const tombstones =
    value.tombstones === undefined
      ? undefined
      : parseMutationArray(value.tombstones, parseAgentStatusTombstoneInput)
  const reopenStructuredParent =
    value.reopenStructuredParent === undefined
      ? undefined
      : value.reopenStructuredParent === true && parent?.subject.kind === 'structured-session'
        ? true
        : null
  const parsedValues = [
    parent,
    removeParent,
    children,
    removeChildren,
    aliases,
    removeAliases,
    facts,
    removeFacts,
    tombstones,
    reopenStructuredParent
  ]
  const sourceValues = optionalKeys.map((key) => value[key])
  if (sourceValues.some((item, index) => item !== undefined && !parsedValues[index])) {
    return null
  }
  const mutationEntryCount = [
    children,
    removeChildren,
    aliases,
    removeAliases,
    facts,
    removeFacts,
    tombstones
  ].reduce((sum, items) => sum + (items?.length ?? 0), 0)
  if (mutationEntryCount > AGENT_STATUS_STORE_LIMITS.mutationEntries) {
    return null
  }
  return {
    ...(parent ? { parent } : {}),
    ...(reopenStructuredParent ? { reopenStructuredParent: true as const } : {}),
    ...(removeParent ? { removeParent } : {}),
    ...(children ? { children } : {}),
    ...(removeChildren ? { removeChildren } : {}),
    ...(aliases ? { aliases } : {}),
    ...(removeAliases ? { removeAliases } : {}),
    ...(facts ? { facts } : {}),
    ...(removeFacts ? { removeFacts } : {}),
    ...(tombstones ? { tombstones } : {})
  }
}

export function parseAgentStatusStoreSnapshot(value: unknown): AgentStatusStoreSnapshot | null {
  const keys = [
    'version',
    'epoch',
    'revision',
    'parents',
    'children',
    'aliases',
    'facts',
    'tombstones'
  ]
  if (
    !isWithinSerializedLimit(value) ||
    !isRecord(value) ||
    !hasOnlyKeys(value, keys) ||
    value.version !== AGENT_STATUS_STORE_SNAPSHOT_VERSION ||
    !isAgentStatusStoreEpoch(value.epoch) ||
    !isRevision(value.revision)
  ) {
    return null
  }
  const parents = parseArray(
    value.parents,
    parseAgentStatusParentRecord,
    AGENT_STATUS_STORE_LIMITS.parents
  )
  const children = parseArray(
    value.children,
    parseAgentChildWorkRecord,
    AGENT_STATUS_STORE_LIMITS.children
  )
  const aliases = parseArray(
    value.aliases,
    parseAgentChildWorkAliasRecord,
    AGENT_STATUS_STORE_LIMITS.aliases
  )
  const facts = parseArray(value.facts, parseAgentStatusFactRecord, AGENT_STATUS_STORE_LIMITS.facts)
  const tombstones = parseArray(
    value.tombstones,
    parseAgentStatusTombstoneRecord,
    AGENT_STATUS_STORE_LIMITS.tombstones
  )
  return parents && children && aliases && facts && tombstones
    ? {
        version: AGENT_STATUS_STORE_SNAPSHOT_VERSION,
        epoch: value.epoch,
        revision: value.revision,
        parents,
        children,
        aliases,
        facts,
        tombstones
      }
    : null
}
