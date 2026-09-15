import {
  parseAgentStatusProviderAlias,
  isAgentStatusRunId,
  type AgentStatusProviderAlias,
  type AgentStatusRunId
} from './agent-status-run'
import {
  parseAgentStatusExecutionScope,
  type AgentStatusExecutionScope
} from './agent-status-subject'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { measureUtf8ByteLength } from './utf8-byte-limits'

const PROVIDER_ALIAS_KEY_PREFIX = 'agent-status-provider-alias-v1:'

const MAX_ALIAS_INDEX_ENTRIES = 4096

const MAX_RUN_IDS_PER_ALIAS = 256

const MAX_ALIAS_INDEX_RUN_REFERENCES = 16_384

const MAX_ALIAS_INDEX_SERIALIZED_BYTES = 4 * 1024 * 1024

const ALIAS_INDEX_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64 * 1024,
  nestingDepth: 3
} as const

export type AgentStatusScopedProviderAlias = AgentStatusExecutionScope & AgentStatusProviderAlias

export type AgentStatusProviderAliasKey = string

/** One provider tuple can resolve to multiple concurrently live run ids. */
export type AgentStatusRunAliasIndex = Map<AgentStatusProviderAliasKey, Set<AgentStatusRunId>>

type ProviderAliasKeyTuple = readonly [
  executionHostId: string,
  wslDistro: string | null,
  workspaceId: string,
  workspaceKind: AgentStatusExecutionScope['workspaceKind'],
  provider: AgentStatusProviderAlias['provider'],
  sessionKeyKind: AgentStatusProviderAlias['sessionKeyKind'],
  providerId: string
]

type SerializedAliasIndexEntry = {
  alias: string
  runIds: AgentStatusRunId[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(record)

  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key))
}

export function parseAgentStatusScopedProviderAlias(
  value: unknown
): AgentStatusScopedProviderAlias | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'executionHostId',
      'wslDistro',
      'workspaceId',
      'workspaceKind',
      'provider',
      'sessionKeyKind',
      'providerId'
    ])
  ) {
    return null
  }

  const scope = parseAgentStatusExecutionScope({
    executionHostId: value.executionHostId,
    wslDistro: value.wslDistro,
    workspaceId: value.workspaceId,
    workspaceKind: value.workspaceKind
  })

  const alias = parseAgentStatusProviderAlias({
    provider: value.provider,
    sessionKeyKind: value.sessionKeyKind,
    providerId: value.providerId
  })

  return scope && alias ? { ...scope, ...alias } : null
}

function providerAliasKeyTuple(alias: AgentStatusScopedProviderAlias): ProviderAliasKeyTuple {
  return [
    alias.executionHostId,
    alias.wslDistro,
    alias.workspaceId,
    alias.workspaceKind,
    alias.provider,
    alias.sessionKeyKind,
    alias.providerId
  ]
}

export function serializeAgentStatusProviderAliasKey(
  alias: AgentStatusScopedProviderAlias
): AgentStatusProviderAliasKey {
  const parsed = parseAgentStatusScopedProviderAlias(alias)

  if (!parsed) {
    throw new Error('Invalid agent status provider alias')
  }

  return `${PROVIDER_ALIAS_KEY_PREFIX}${JSON.stringify(providerAliasKeyTuple(parsed))}`
}

export function deserializeAgentStatusProviderAliasKey(
  value: AgentStatusProviderAliasKey
): AgentStatusScopedProviderAlias | null {
  if (!value.startsWith(PROVIDER_ALIAS_KEY_PREFIX)) {
    return null
  }

  let tuple: unknown

  try {
    tuple = JSON.parse(value.slice(PROVIDER_ALIAS_KEY_PREFIX.length))
  } catch {
    return null
  }

  if (!Array.isArray(tuple) || tuple.length !== 7) {
    return null
  }

  const [
    executionHostId,
    wslDistro,
    workspaceId,
    workspaceKind,
    provider,
    sessionKeyKind,
    providerId
  ] = tuple

  const alias = parseAgentStatusScopedProviderAlias({
    executionHostId,
    wslDistro,
    workspaceId,
    workspaceKind,
    provider,
    sessionKeyKind,
    providerId
  })

  return alias && serializeAgentStatusProviderAliasKey(alias) === value ? alias : null
}

export function serializeAgentStatusRunAliasIndex(
  index: ReadonlyMap<AgentStatusProviderAliasKey, ReadonlySet<AgentStatusRunId>>
): string {
  if (index.size > MAX_ALIAS_INDEX_ENTRIES) {
    throw new Error('Agent status alias index exceeds its entry limit')
  }

  const entries: SerializedAliasIndexEntry[] = []
  let runReferenceCount = 0

  for (const [aliasKey, runIds] of index) {
    if (
      !deserializeAgentStatusProviderAliasKey(aliasKey) ||
      runIds.size === 0 ||
      runIds.size > MAX_RUN_IDS_PER_ALIAS
    ) {
      throw new Error('Invalid agent status alias index entry')
    }

    const serializedRunIds = [...runIds]

    if (!serializedRunIds.every(isAgentStatusRunId)) {
      throw new Error('Invalid agent status alias run id')
    }

    runReferenceCount += serializedRunIds.length

    if (runReferenceCount > MAX_ALIAS_INDEX_RUN_REFERENCES) {
      throw new Error('Agent status alias index exceeds its run-reference limit')
    }

    serializedRunIds.sort()
    entries.push({ alias: aliasKey, runIds: serializedRunIds })
  }

  entries.sort((left, right) => (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0))
  const serialized = JSON.stringify(entries)

  if (
    measureUtf8ByteLength(serialized, { stopAfterBytes: MAX_ALIAS_INDEX_SERIALIZED_BYTES })
      .exceededLimit
  ) {
    throw new Error('Agent status alias index exceeds its serialized-byte limit')
  }

  return serialized
}

export function deserializeAgentStatusRunAliasIndex(
  value: string
): AgentStatusRunAliasIndex | null {
  if (
    measureUtf8ByteLength(value, { stopAfterBytes: MAX_ALIAS_INDEX_SERIALIZED_BYTES }).exceededLimit
  ) {
    return null
  }

  let parsed: unknown

  try {
    assertJsonTextStructureWithinLimits(value, ALIAS_INDEX_JSON_STRUCTURE_LIMITS)
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  if (!Array.isArray(parsed) || parsed.length > MAX_ALIAS_INDEX_ENTRIES) {
    return null
  }

  const index: AgentStatusRunAliasIndex = new Map()
  let runReferenceCount = 0

  for (const entry of parsed) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['alias', 'runIds']) ||
      typeof entry.alias !== 'string' ||
      !deserializeAgentStatusProviderAliasKey(entry.alias) ||
      !Array.isArray(entry.runIds) ||
      entry.runIds.length === 0 ||
      entry.runIds.length > MAX_RUN_IDS_PER_ALIAS ||
      !entry.runIds.every(isAgentStatusRunId) ||
      new Set(entry.runIds).size !== entry.runIds.length ||
      index.has(entry.alias)
    ) {
      return null
    }

    runReferenceCount += entry.runIds.length

    if (runReferenceCount > MAX_ALIAS_INDEX_RUN_REFERENCES) {
      return null
    }

    index.set(entry.alias, new Set(entry.runIds))
  }

  return index
}
