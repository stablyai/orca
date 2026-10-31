import {
  isSubagentGroupBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from './native-chat-types'

export type NativeChatRowSources = { identity: string[]; content: string[] }
type Sources = NativeChatRowSources

export type NativeChatAssignedRows = {
  rows: readonly NativeChatMessage[]
  messages: readonly NativeChatMessage[]
  keyById: ReadonlyMap<string, string>
  sources?: readonly Sources[]
  prepareSources?: () => readonly Sources[]
}
type Assigned = NativeChatAssignedRows

// Block object identity survives folding and identifies its source message.
function blockOwners(messages: readonly NativeChatMessage[]): Map<NativeChatBlock, string> {
  const owners = new Map<NativeChatBlock, string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (!owners.has(block)) {
        owners.set(block, message.id)
      }
    }
  }
  return owners
}

// Use assistant/calls for run identity; results are content only and cannot inherit its key. Rosters use group identity.
function sourcesOf(row: NativeChatMessage, owners: Map<NativeChatBlock, string>): Sources {
  const own = new Set<string>()
  const results = new Set<string>()
  for (const block of row.blocks) {
    const owner = owners.get(block)
    if (isSubagentGroupBlock(block)) {
      own.add(`subagent-group:${block.groupId}`)
    } else if (owner !== undefined && isToolResultBlock(block)) {
      results.add(`result:${owner}`)
    } else if (owner !== undefined) {
      own.add(`body:${owner}`)
    }
  }
  const content = [...own, ...results]
  const identity = own.size > 0 ? [...own] : results.size > 0 ? [...results] : [`body:${row.id}`]
  return { identity, content: content.length > 0 ? content : identity }
}

export function prepareNativeChatRowSources(messages: readonly NativeChatMessage[]) {
  let owners: Map<NativeChatBlock, string> | undefined
  const cache = new WeakMap<NativeChatMessage, Sources>()
  return (row: NativeChatMessage): Sources => {
    let sources = cache.get(row)
    if (!sources) {
      sources = sourcesOf(row, (owners ??= blockOwners(messages)))
      cache.set(row, sources)
    }
    return sources
  }
}

function sourcesByRow(
  rows: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  scopeOf?: (row: NativeChatMessage) => string | undefined
): Sources[] {
  const owners = blockOwners(messages)
  return rows.map((row) => {
    const sources = sourcesOf(row, owners)
    if (!scopeOf) {
      return sources
    }
    const scoped = (source: string) => `${source}\0${scopeOf(row) ?? ''}`
    return { identity: sources.identity.map(scoped), content: sources.content.map(scoped) }
  })
}

export function assignNativeChatRowKeys(
  previous: Assigned | null,
  rows: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  fresh?: () => string,
  scopeOf?: (row: NativeChatMessage) => string | undefined,
  preparedSources?: () => readonly Sources[]
): Pick<Assigned, 'sources'> & {
  keyById: Map<string, string>
  moved: Map<string, string | undefined>
} {
  const keyById = new Map<string, string>()
  const taken = new Set<string>()
  const take = (row: NativeChatMessage, key: string): void => {
    keyById.set(row.id, key)
    taken.add(key)
  }
  const ids = new Set(rows.map((row) => row.id))
  let before: readonly Sources[] = []
  let now: readonly Sources[] | undefined
  const current = () => (now ??= preparedSources?.() ?? sourcesByRow(rows, messages, scopeOf))
  if (fresh) {
    current()
  }
  if (!fresh && previous?.rows.every((row) => ids.has(row.id))) {
    for (const row of rows) {
      const key = previous.keyById.get(row.id)
      if (key !== undefined) {
        take(row, key)
      }
    }
  } else if (previous) {
    before =
      previous.sources ??
      previous.prepareSources?.() ??
      sourcesByRow(previous.rows, previous.messages)
    current()
    const was = new Map<string, number>()
    before.forEach(({ identity }, at) => identity.forEach((source) => was.set(source, at)))
    // Inherit only one unclaimed origin key; ambiguous origins must not create duplicate row keys.
    const origins = current().map(
      ({ identity }) => new Set(identity.flatMap((s) => was.get(s) ?? []))
    )
    const heirs = new Map<number, number>()
    origins.forEach((from) => from.forEach((at) => heirs.set(at, (heirs.get(at) ?? 0) + 1)))
    origins.forEach((from, at) => {
      const [origin] = from
      const only = origin !== undefined && from.size === 1 && heirs.get(origin) === 1
      const key = only ? previous.keyById.get(previous.rows[origin]!.id) : undefined
      if (key !== undefined) {
        take(rows[at]!, key)
      }
    })
  }
  for (const row of rows.filter((unkeyed) => !keyById.has(unkeyed.id))) {
    let key = fresh?.() ?? row.id
    for (let n = 1; taken.has(key); n += 1) {
      key = `${row.id}~${n}`
    }
    take(row, key)
  }
  // Redirect lost keys to rows absorbing their identity; orphan results cannot keep a run alive after its last call leaves.
  const drawnAt = new Map<string, number>()
  now?.forEach(({ identity, content }, at) => {
    if (!identity[0]!.startsWith('result:')) {
      content.forEach((s) => {
        if (!drawnAt.has(s)) {
          drawnAt.set(s, at)
        }
      })
    }
  })
  const moved = new Map<string, string | undefined>()
  before.forEach(({ content }, at) => {
    const key = previous?.keyById.get(previous.rows[at]!.id)
    if (key !== undefined && !taken.has(key)) {
      const holder = rows[Math.min(...content.map((s) => drawnAt.get(s) ?? Infinity))]
      moved.set(key, holder && keyById.get(holder.id))
    }
  })
  return { keyById, moved, ...(now ? { sources: now } : {}) }
}
