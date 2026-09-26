type RecordValue = Record<string, unknown>
type Shape = 'snapshot' | 'tab' | 'group' | 'retired' | 'status' | 'history'

const ID_FIELDS = new Set([
  'id',
  'parentTabId',
  'leafId',
  'ptyId',
  'incarnationId',
  'terminal',
  'activeGroupId',
  'activeTabId',
  'publicationEpoch',
  'paneKey'
])
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ROUTING_ID = new RegExp(`^(?:term_)?${UUID}(?:::?${UUID})?$`, 'i')
const ENUM_FIELDS = new Set([
  'type',
  'status',
  'state',
  'activeTabType',
  'viewMode',
  'launchAgent',
  'navigationIntent'
])
const ENUM_VALUES = new Set([
  'snapshot',
  'snapshots',
  'updated',
  'terminal',
  'markdown',
  'file',
  'browser',
  'agent-session',
  'ready',
  'pending-handle',
  'chat',
  'claude',
  'codex',
  'follow',
  'working',
  'waiting',
  'blocked',
  'done'
])
const FLAG_FIELDS = new Set([
  'isActive',
  'isPinned',
  'removed',
  'authoritative',
  'clientHostedPagesUnreconciled'
])
const NUMBER_FIELDS = new Set(['snapshotVersion', 'updatedAt', 'stateStartedAt', 'startedAt'])
const LITERAL_PREFIX = '$literal:'
const STRUCTURAL_FIELDS: Record<Shape, ReadonlySet<string>> = {
  snapshot: new Set([
    'type',
    'publicationEpoch',
    'snapshotVersion',
    'activeGroupId',
    'activeTabId',
    'activeTabType',
    'navigationIntent',
    'removed',
    'authoritative',
    'clientHostedPagesUnreconciled'
  ]),
  tab: new Set([
    'type',
    'id',
    'parentTabId',
    'leafId',
    'ptyId',
    'incarnationId',
    'terminal',
    'status',
    'viewMode',
    'launchAgent',
    'isActive',
    'isPinned'
  ]),
  group: new Set(['id', 'activeTabId']),
  retired: new Set(['parentTabId', 'leafId', 'ptyId', 'incarnationId', 'terminal']),
  status: new Set(['state', 'updatedAt', 'stateStartedAt', 'paneKey']),
  history: new Set(['state', 'startedAt'])
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Only schema-owned routing IDs/enums enter the dictionary; free-form and future fields stay opaque.
function mapStructure(
  value: unknown,
  shape: Shape,
  literals: unknown[],
  restoring: boolean,
  cursor: { next: number }
): unknown {
  const take = (index: unknown): unknown => {
    if (index !== cursor.next || cursor.next >= literals.length) {
      throw new Error('Invalid runtime snapshot literal reference')
    }
    return literals[cursor.next++]
  }
  if (restoring && isRecord(value) && Object.keys(value).length === 1 && 'literal' in value) {
    return take(value.literal)
  }
  if (!isRecord(value)) {
    if (restoring) {
      throw new Error('Invalid runtime snapshot structure')
    }
    return { literal: literals.push(value) - 1 }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      if (restoring && key.startsWith(LITERAL_PREFIX)) {
        const entry = take(Number(key.slice(LITERAL_PREFIX.length)))
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          field !== null
        ) {
          throw new Error('Invalid runtime snapshot field')
        }
        return entry
      }
      if (key === 'snapshots' && shape === 'snapshot' && Array.isArray(field)) {
        return [
          key,
          field.map((snapshot) => mapStructure(snapshot, 'snapshot', literals, restoring, cursor))
        ]
      }
      if (key === 'agentStatus' && shape === 'tab' && isRecord(field)) {
        return [key, mapStructure(field, 'status', literals, restoring, cursor)]
      }
      if (key === 'stateHistory' && shape === 'status' && Array.isArray(field)) {
        return [
          key,
          field.map((entry) => mapStructure(entry, 'history', literals, restoring, cursor))
        ]
      }
      const childShape =
        shape === 'snapshot'
          ? key === 'tabs'
            ? 'tab'
            : key === 'tabGroups'
              ? 'group'
              : key === 'retiredTerminalSurfaces'
                ? 'retired'
                : null
          : null
      if (childShape && Array.isArray(field)) {
        return [
          key,
          field.map((child) => mapStructure(child, childShape, literals, restoring, cursor))
        ]
      }
      if (
        key === 'tabOrder' &&
        shape === 'group' &&
        Array.isArray(field) &&
        field.every((id) => typeof id === 'string' && ROUTING_ID.test(id))
      ) {
        return [key, field]
      }
      if (
        STRUCTURAL_FIELDS[shape].has(key) &&
        ((ID_FIELDS.has(key) &&
          (field === null || (typeof field === 'string' && ROUTING_ID.test(field)))) ||
          (ENUM_FIELDS.has(key) &&
            (field === null || (typeof field === 'string' && ENUM_VALUES.has(field)))) ||
          (FLAG_FIELDS.has(key) && typeof field === 'boolean') ||
          (NUMBER_FIELDS.has(key) && typeof field === 'number'))
      ) {
        return [key, field]
      }
      if (restoring) {
        throw new Error('Unexpected runtime snapshot structural field')
      }
      return [`${LITERAL_PREFIX}${literals.push([key, field]) - 1}`, null]
    })
  )
}

export function splitRuntimeSnapshotStructure(result: unknown): {
  structure: unknown
  literals: unknown[]
} {
  const literals: unknown[] = []
  const structure = mapStructure(result, 'snapshot', literals, false, { next: 0 })
  return { structure, literals }
}

export function restoreRuntimeSnapshotStructure(structure: unknown, literals: unknown[]): unknown {
  const cursor = { next: 0 }
  const result = mapStructure(structure, 'snapshot', literals, true, cursor)
  if (cursor.next !== literals.length) {
    throw new Error('Unused runtime snapshot literals')
  }
  return result
}
