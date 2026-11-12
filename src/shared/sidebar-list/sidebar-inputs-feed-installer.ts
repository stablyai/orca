import {
  SIDEBAR_INPUTS_PAGE_MAX_BYTES,
  type SidebarInputsChangedEvent,
  type SidebarInputsDomainChange,
  type SidebarInputsReadParams,
  type SidebarInputsReadResult
} from './sidebar-inputs-feed-contract'

/** Install whole batches at one revision; consumers reject unreadable schema/semantics versions with “Reopen to update”. */
export type InstalledSidebarInputs = {
  generation: string
  revision: number
  schemaVersion: number
  semanticsVersion: number
  domains: ReadonlyMap<string, ReadonlyMap<string, unknown>>
}

type StagedBatch = Pick<SidebarInputsReadResult, 'generation' | 'revision' | 'kind' | 'from'> & {
  pages: readonly SidebarInputsReadResult['domains'][]
}

type FeedPosition = Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>

/** One host-connection reader: refresh supersedes in-flight reads, and uncovered notices (even during paging) trigger another. */
export type SidebarInputsFeedState = {
  installed: InstalledSidebarInputs | null
  /** The pages of the batch being read, installed only once its last page lands. */
  staged: StagedBatch | null
  /** The read in flight; a reply to any other request is stale and dropped. */
  inFlight: number | null
  /** The newest notice that arrived after the read in flight was sent. */
  noticed: FeedPosition | null
  lastRequestId: number
}

export type SidebarInputsFeedRequest = { id: number; params: SidebarInputsReadParams }

export type SidebarInputsFeedStep = {
  state: SidebarInputsFeedState
  /** The read to send now, if any. */
  request: SidebarInputsFeedRequest | null
}

export const INITIAL_SIDEBAR_INPUTS_FEED_STATE: SidebarInputsFeedState = {
  installed: null,
  staged: null,
  inFlight: null,
  noticed: null,
  lastRequestId: 0
}

function covers(position: FeedPosition | null, notice: FeedPosition): boolean {
  return position?.generation === notice.generation && position.revision >= notice.revision
}

function send(
  state: SidebarInputsFeedState,
  params: Omit<SidebarInputsReadParams, 'maxBytes'>
): SidebarInputsFeedStep {
  const id = state.lastRequestId + 1
  return {
    state: { ...state, inFlight: id, lastRequestId: id },
    request: { id, params: { ...params, maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES } }
  }
}

/** A fresh read: the host serves it at its current revision, past every notice so far. */
function readFromInstalled(state: SidebarInputsFeedState): SidebarInputsFeedStep {
  const { installed } = state
  return send(
    { ...state, staged: null, noticed: null },
    installed ? { generation: installed.generation, cursor: installed.revision } : {}
  )
}

/** On every stream ready and return to the foreground; supersedes a read in flight. */
export function refreshSidebarInputs(state: SidebarInputsFeedState): SidebarInputsFeedStep {
  return readFromInstalled(state)
}

/** A change notice; one this reader already has or is fetching is a duplicate or arrived late. */
export function sidebarInputsChanged(
  state: SidebarInputsFeedState,
  notice: FeedPosition
): SidebarInputsFeedStep {
  if (covers(state.staged ?? state.installed, notice) || covers(state.noticed, notice)) {
    return { state, request: null }
  }
  return state.inFlight === null
    ? readFromInstalled(state)
    : { state: { ...state, noticed: notice }, request: null }
}

/** The read failed; its reader retries with a refresh, which reads past every notice so far. */
export function sidebarInputsReadFailed(
  state: SidebarInputsFeedState,
  requestId: number
): SidebarInputsFeedState {
  return requestId === state.inFlight
    ? { ...state, inFlight: null, staged: null, noticed: null }
    : state
}

export function sidebarInputsReplied(
  state: SidebarInputsFeedState,
  requestId: number,
  reply: SidebarInputsReadResult
): SidebarInputsFeedStep {
  if (requestId !== state.inFlight) {
    return { state, request: null }
  }
  const settled = { ...state, inFlight: null }
  if (reply.kind === 'reset') {
    return readFromInstalled(settled)
  }
  const { staged, installed } = state
  const continues = staged
    ? staged.generation === reply.generation &&
      staged.revision === reply.revision &&
      staged.kind === reply.kind &&
      staged.from === reply.from
    : reply.kind === 'snapshot' ||
      (installed?.generation === reply.generation && reply.from === installed.revision)
  if (!continues) {
    // Not the batch this reader asked for: only a whole snapshot is safe now.
    return send({ ...settled, staged: null, noticed: null }, {})
  }
  const batch: StagedBatch = {
    generation: reply.generation,
    revision: reply.revision,
    kind: reply.kind,
    from: reply.from,
    pages: [...(staged?.pages ?? []), reply.domains]
  }
  if (reply.next !== null) {
    return send({ ...settled, staged: batch }, { pageToken: reply.next })
  }
  // A batch older than what is installed (a late snapshot) installs nothing.
  const stale = installed?.generation === batch.generation && batch.revision < installed.revision
  const next = stale ? installed : installBatch(installed, batch, reply)
  if (!next) {
    return send({ ...settled, staged: null, noticed: null }, {})
  }
  const done = { ...settled, staged: null, installed: next }
  return done.noticed && !covers(next, done.noticed)
    ? readFromInstalled(done)
    : { state: { ...done, noticed: null }, request: null }
}

/** Applies a whole batch as one step; null when an entity's joined parts are not JSON. */
function installBatch(
  installed: InstalledSidebarInputs | null,
  batch: StagedBatch,
  last: Pick<SidebarInputsReadResult, 'schemaVersion' | 'semanticsVersion'>
): InstalledSidebarInputs | null {
  const domains = new Map(batch.kind === 'snapshot' ? [] : (installed?.domains ?? []))
  const touched = new Map<string, Map<string, unknown>>()
  const parts = new Map<string, Map<string, string>>()
  const entitiesOf = (name: string): Map<string, unknown> => {
    let entities = touched.get(name)
    if (!entities) {
      entities = new Map(domains.get(name) ?? [])
      touched.set(name, entities)
    }
    return entities
  }
  for (const page of batch.pages) {
    for (const [name, change] of Object.entries(page)) {
      applyDomainChange(entitiesOf(name), change, parts, name)
    }
  }
  for (const [name, texts] of parts) {
    for (const [key, text] of texts) {
      try {
        entitiesOf(name).set(key, JSON.parse(text))
      } catch {
        return null
      }
    }
  }
  for (const [name, entities] of touched) {
    domains.set(name, entities)
  }
  return {
    generation: batch.generation,
    revision: batch.revision,
    schemaVersion: last.schemaVersion,
    semanticsVersion: last.semanticsVersion,
    domains
  }
}

function applyDomainChange(
  entities: Map<string, unknown>,
  change: SidebarInputsDomainChange,
  parts: Map<string, Map<string, string>>,
  name: string
): void {
  for (const [key, value] of Object.entries(change.upserts)) {
    entities.set(key, value)
  }
  for (const key of change.removals) {
    entities.delete(key)
  }
  for (const [key, text] of Object.entries(change.parts)) {
    const texts = parts.get(name) ?? new Map<string, string>()
    parts.set(name, texts)
    texts.set(key, (texts.get(key) ?? '') + text)
  }
}
