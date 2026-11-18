// Each paired server's last full bot read, kept across restarts so a server that is away still lists its bots, dimmed.
// Publishing only marks a server dirty; one trailing flush writes the servers whose kept record really changed.
import * as z from 'zod'
import type { Bot } from '../../../shared/bot-types'
import type { BotGroup } from '../../../shared/bots/bot-group'
import type { BotListWaits } from '../../../shared/bots/bot-list-waits'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { BotHostConnectorStatus } from './bot-catalog-snapshot'

// One key per server, so a write carries one server and two windows never overwrite each other's servers.
const KEY_PREFIX = 'orca.bots.pairedHostList.v2:'
const RUNTIME_PREFIX = 'runtime:'
export const KEPT_BOT_LIST_FLUSH_MS = 1_500

/** What a dimmed row needs of its home; activity stamps stay out, so a bot's turn never counts as a change. */
export type KeptBotHome = Pick<
  FolderWorkspace,
  'id' | 'name' | 'folderPath' | 'executionHostId' | 'projectGroupId' | 'sortOrder'
>

// Each part is checked only for its outer shape: the server's next read replaces it whole.
const someObject = (value: unknown): boolean => typeof value === 'object' && value !== null
const keptListSchema = z.object({
  /** Which pairing the record was read under; a re-pair to another server under the same id drops it. */
  pairing: z.string().optional(),
  bots: z.array(z.custom<Bot>(someObject)),
  threadReplies: z.boolean().catch(false),
  webhooks: z.boolean().optional().catch(undefined),
  connectorNeedsSignIn: z.boolean().catch(false),
  connectorStatus: z
    .custom<BotHostConnectorStatus>((value) => typeof value === 'string')
    .optional()
    .catch(undefined),
  waits: z.custom<BotListWaits>(someObject).catch({}),
  groups: z.array(z.custom<BotGroup>(someObject)).catch([]),
  homes: z.array(z.custom<KeptBotHome>(someObject)).catch([])
})

export type KeptBotHostList = Omit<z.infer<typeof keptListSchema>, 'bots' | 'groups' | 'homes'> & {
  bots: readonly Bot[]
  groups: readonly BotGroup[]
  homes: readonly KeptBotHome[]
}

/** The parts of a server's newest read; homes are read at flush time. */
export type KeptBotHostRead = Partial<Omit<KeptBotHostList, 'pairing' | 'homes'>>

const EMPTY: KeptBotHostList = {
  bots: [],
  threadReplies: false,
  webhooks: undefined,
  connectorNeedsSignIn: false,
  connectorStatus: undefined,
  waits: {},
  groups: [],
  homes: []
}

type KeptHost = {
  list: KeptBotHostList
  /** The record as last read from or written to storage; null when storage holds none. */
  saved: string | null
}

type HomesReader = (hostId: ExecutionHostId, list: KeptBotHostList) => readonly KeptBotHome[]

const kept = new Map<ExecutionHostId, KeptHost>()
// Each paired server's pairing, from the catalog's last pass; stamped on what is kept for it.
let pairings: ReadonlyMap<ExecutionHostId, string> = new Map()
const dirty = new Set<ExecutionHostId>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnLeave = false
let readHomes: HomesReader = (_hostId, list) => list.homes

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function keptHost(hostId: ExecutionHostId): KeptHost | null {
  const cached = kept.get(hostId)
  if (cached) {
    return cached
  }
  let raw: string | null = null
  try {
    raw = storage()?.getItem(`${KEY_PREFIX}${hostId}`) ?? null
  } catch {
    // Unreadable storage keeps nothing; the next read writes it again.
  }
  if (raw === null) {
    return null
  }
  try {
    const parsed = keptListSchema.safeParse(JSON.parse(raw))
    if (parsed.success) {
      const entry = { list: parsed.data, saved: raw }
      kept.set(hostId, entry)
      return entry
    }
  } catch {
    // Falls through: a damaged record keeps nothing.
  }
  return null
}

/** Writes each dirty server whose record changed since it was last saved; an unchanged one costs no write. */
export function flushKeptBotHostLists(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const store = storage()
  for (const hostId of dirty) {
    const entry = kept.get(hostId)
    if (!entry) {
      continue
    }
    entry.list = { ...entry.list, homes: readHomes(hostId, entry.list) }
    const record = JSON.stringify(entry.list)
    if (record === entry.saved) {
      continue
    }
    try {
      store?.setItem(`${KEY_PREFIX}${hostId}`, record)
      entry.saved = record
    } catch {
      // Storage full or unavailable: the list still lives for this session.
    }
  }
  dirty.clear()
}

/** Where the flush finds each server's homes as the app lists them now. */
export function setKeptBotHomesReader(reader: HomesReader): void {
  readHomes = reader
}

/** The server's last full bot read, or null when none is kept. */
export function readKeptBotHostList(hostId: ExecutionHostId): KeptBotHostList | null {
  return keptHost(hostId)?.list ?? null
}

/** Takes the server's newest read in memory; storage follows on the trailing flush, only if it changed. */
export function keepBotHostList(hostId: ExecutionHostId, read: KeptBotHostRead): void {
  const entry = keptHost(hostId) ?? { list: EMPTY, saved: null }
  const pairing = pairings.get(hostId) ?? entry.list.pairing
  entry.list = { ...entry.list, ...read, ...(pairing === undefined ? {} : { pairing }) }
  kept.set(hostId, entry)
  markKeptBotHostDirty(hostId)
}

/** Something a kept record is built from may have changed, such as its homes; the flush decides whether to write. */
export function markKeptBotHostDirty(hostId: ExecutionHostId): void {
  if (kept.has(hostId)) {
    dirty.add(hostId)
    flushTimer ??= setTimeout(flushKeptBotHostLists, KEPT_BOT_LIST_FLUSH_MS)
    if (!flushOnLeave && typeof window !== 'undefined' && 'addEventListener' in window) {
      flushOnLeave = true
      // A reload or quit inside the flush delay still keeps the newest read.
      window.addEventListener('pagehide', flushKeptBotHostLists)
    }
  }
}

function storedHostIds(store: Storage | null): ExecutionHostId[] {
  const ids: ExecutionHostId[] = []
  try {
    for (let index = 0; index < (store?.length ?? 0); index++) {
      const key = store?.key(index)
      const hostId = key?.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null
      if (hostId?.startsWith(RUNTIME_PREFIX)) {
        ids.push(`${RUNTIME_PREFIX}${hostId.slice(RUNTIME_PREFIX.length)}`)
      }
    }
  } catch {
    // Unreadable storage: only what this session kept is checked.
  }
  return ids
}

/**
 * Forgets every server not in `paired` (host id → its pairing), and any re-paired under the same id: an
 * unpaired or replaced server's bots go with it. A record kept before the catalog was known takes its pairing.
 */
export function retainKeptBotHostLists(paired: ReadonlyMap<ExecutionHostId, string>): void {
  pairings = paired
  const store = storage()
  for (const hostId of new Set([...kept.keys(), ...storedHostIds(store)])) {
    const pairing = paired.get(hostId)
    const entry = keptHost(hostId)
    if (pairing !== undefined && entry?.list.pairing === pairing) {
      continue
    }
    if (pairing !== undefined && entry && entry.list.pairing === undefined) {
      entry.list = { ...entry.list, pairing }
      markKeptBotHostDirty(hostId)
      continue
    }
    kept.delete(hostId)
    dirty.delete(hostId)
    try {
      store?.removeItem(`${KEY_PREFIX}${hostId}`)
    } catch {
      // Left for the next catalog pass.
    }
  }
}
