import type { AgentSenderPublication } from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import type { LocatedAgentSender } from './agent-sender-index'

type Located = LocatedAgentSender | null
type Row = LocatedAgentSender
/** A publication's rows on this window's panes; attachments carry the principal they run for. */
export type LocatedRows = {
  associations: readonly Row[]
  attachments: readonly (readonly [principal: string, row: Row])[]
}
/** One host's rows on this window's panes (null where they disagree), with reverse pane maps. */
export type HostPart = {
  identities: ReadonlyMap<string, Located>
  /** Home principals named by any of the host's publications, with how many name each. */
  principals: ReadonlyMap<string, number>
  /** The rows it runs for each home principal that attached them. */
  attachments: ReadonlyMap<string, ReadonlyMap<string, Located>>
  panes: ReadonlyMap<string, readonly string[]>
  attachedPanes: ReadonlyMap<string, readonly (readonly [principal: string, identity: string])[]>
  /** Every kept row behind each merged answer, so one scope can leave without a rebuild. */
  claimRows: ReadonlyMap<string, readonly Row[]>
  attachmentRows: ReadonlyMap<string, ReadonlyMap<string, readonly Row[]>>
}

const wholeHostRowsByWorktree = new WeakMap<LocatedRows, Map<string, LocatedRows>>()
type Attached = LocatedRows['attachments'][number]

export const paneId = (row: Row) => JSON.stringify([row.worktreeId, row.paneKey])
const principalId = (p: AgentSenderPublication['principals'][number]) =>
  JSON.stringify([p.peerFingerprint, p.homePeerFingerprint])

/** Equal claims keep the first; a disagreement, or an ambiguous claim, is ambiguous. */
export function merge(current: Located | undefined, next: Located): Located
export function merge(current: Located | undefined, next: Located | undefined): Located | undefined
export function merge(
  current: Located | undefined,
  next: Located | undefined
): Located | undefined {
  if (next === undefined || current === null) {
    return current
  }
  if (current === undefined || next === null) {
    return next
  }
  return JSON.stringify(current) === JSON.stringify(next) ? current : null
}

const fold = (rows: readonly Row[]): Located | undefined =>
  rows.reduce<Located | undefined>((value, row) => merge(value, row), undefined)

/** Lists by key, copied on a draft's first write to each key and then written in place. */
class DraftLists<K, T> {
  readonly map: Map<K, readonly T[]>
  private readonly owned = new Map<K, T[]>()
  constructor(base: ReadonlyMap<K, readonly T[]> | undefined) {
    this.map = new Map(base)
  }

  add(id: K, value: T): void {
    this.own(id).push(value)
  }

  remove(id: K, same: (value: T) => boolean): void {
    const list = this.own(id)
    const at = list.findIndex(same)
    if (at !== -1) {
      list.splice(at, 1)
    }
    if (list.length === 0) {
      this.map.delete(id)
      this.owned.delete(id)
    }
  }

  private own(id: K): T[] {
    let list = this.owned.get(id)
    if (!list) {
      list = [...(this.map.get(id) ?? [])]
      this.owned.set(id, list)
      this.map.set(id, list)
    }
    return list
  }
}

/** A copy of a host part that adds and removes kept rows and principals, copying only the maps
 *  and lists it touches, then re-merges only the identities whose rows moved. */
export class HostPartDraft {
  private readonly claimRows: DraftLists<string, Row>
  private readonly attachmentRows: Map<string, ReadonlyMap<string, readonly Row[]>>
  private readonly ownedAttachmentRows = new Map<string, DraftLists<string, Row>>()
  private readonly principals: Map<string, number>
  private readonly panes: DraftLists<string, string>
  private readonly attachedPanes: DraftLists<string, readonly [string, string]>
  private readonly touchedClaims = new Set<string>()
  private readonly touchedAttachments = new Map<string, Set<string>>()

  constructor(
    private readonly base: HostPart | undefined,
    private readonly onRow: () => void
  ) {
    this.claimRows = new DraftLists(base?.claimRows)
    this.attachmentRows = new Map(base?.attachmentRows)
    this.principals = new Map(base?.principals)
    this.panes = new DraftLists(base?.panes)
    this.attachedPanes = new DraftLists(base?.attachedPanes)
  }

  rows(rows: LocatedRows, sign: 1 | -1, kept: (row: Row) => boolean = () => true): void {
    for (const row of rows.associations) {
      if (kept(row)) {
        this.onRow()
        this.touchedClaims.add(row.identity)
        if (sign > 0) {
          this.claimRows.add(row.identity, row)
          this.panes.add(paneId(row), row.identity)
        } else {
          this.claimRows.remove(row.identity, (value) => value === row)
          this.panes.remove(paneId(row), (value) => value === row.identity)
        }
      }
    }
    for (const [principal, row] of rows.attachments) {
      if (kept(row)) {
        this.onRow()
        const touched = this.touchedAttachments.get(principal) ?? new Set<string>()
        this.touchedAttachments.set(principal, touched.add(row.identity))
        const bucket = this.attachmentBucket(principal)
        if (sign > 0) {
          bucket.add(row.identity, row)
          this.attachedPanes.add(paneId(row), [principal, row.identity])
        } else {
          bucket.remove(row.identity, (value) => value === row)
          this.attachedPanes.remove(
            paneId(row),
            ([p, identity]) => p === principal && identity === row.identity
          )
        }
      }
    }
  }

  publicationPrincipals(publication: AgentSenderPublication, sign: 1 | -1): void {
    for (const principal of publication.principals) {
      const id = principalId(principal)
      const count = (this.principals.get(id) ?? 0) + sign
      if (count > 0) {
        this.principals.set(id, count)
      } else {
        this.principals.delete(id)
      }
    }
  }

  finish(): HostPart {
    const identities = new Map(this.base?.identities)
    for (const identity of this.touchedClaims) {
      const value = fold(this.claimRows.map.get(identity) ?? [])
      if (value === undefined) {
        identities.delete(identity)
      } else {
        identities.set(identity, value)
      }
    }
    const attachments = new Map(this.base?.attachments)
    for (const [principal, touched] of this.touchedAttachments) {
      const rows = this.attachmentRows.get(principal)
      const bucket = new Map(attachments.get(principal))
      for (const identity of touched) {
        const value = fold(rows?.get(identity) ?? [])
        if (value === undefined) {
          bucket.delete(identity)
        } else {
          bucket.set(identity, value)
        }
      }
      if (bucket.size === 0) {
        attachments.delete(principal)
      } else {
        attachments.set(principal, bucket)
      }
      if (rows?.size === 0) {
        this.attachmentRows.delete(principal)
      }
    }
    return {
      identities,
      principals: this.principals,
      attachments,
      panes: this.panes.map,
      attachedPanes: this.attachedPanes.map,
      claimRows: this.claimRows.map,
      attachmentRows: this.attachmentRows
    }
  }

  private attachmentBucket(principal: string): DraftLists<string, Row> {
    let bucket = this.ownedAttachmentRows.get(principal)
    if (!bucket) {
      bucket = new DraftLists(this.attachmentRows.get(principal))
      this.ownedAttachmentRows.set(principal, bucket)
      this.attachmentRows.set(principal, bucket.map)
    }
    return bucket
  }
}

/** The whole-host publication's rows for one worktree, grouped once per placement. */
export function wholeHostRowsFor(rows: LocatedRows, worktreeId: string): LocatedRows {
  let byWorktree = wholeHostRowsByWorktree.get(rows)
  if (!byWorktree) {
    const grouped = new Map<string, { associations: Row[]; attachments: Attached[] }>()
    const bucket = (id: string) => {
      const value = grouped.get(id) ?? { associations: [], attachments: [] }
      grouped.set(id, value)
      return value
    }
    for (const row of rows.associations) {
      bucket(row.worktreeId).associations.push(row)
    }
    for (const entry of rows.attachments) {
      bucket(entry[1].worktreeId).attachments.push(entry)
    }
    byWorktree = grouped
    wholeHostRowsByWorktree.set(rows, byWorktree)
  }
  return byWorktree.get(worktreeId) ?? { associations: [], attachments: [] }
}
