import type { AgentSenderPublication } from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import type { LocatedAgentSender } from './agent-sender-index'
import { OverlayMap, type OverlayMapDraft } from './agent-sender-overlay-map'

type Located = LocatedAgentSender | null
type Row = LocatedAgentSender
/** A publication's rows on this window's panes; attachments carry the principal they run for. */
export type LocatedRows = {
  associations: readonly Row[]
  attachments: readonly (readonly [principal: string, row: Row])[]
}
/** One host's rows on this window's panes (null where they disagree), with reverse pane maps. */
export type HostPart = {
  identities: OverlayMap<string, Located>
  /** Home principals named by any of the host's publications, with how many name each. */
  principals: ReadonlyMap<string, number>
  /** The rows it runs for each home principal that attached them. */
  attachments: OverlayMap<string, OverlayMap<string, Located>>
  panes: OverlayMap<string, readonly string[]>
  attachedPanes: OverlayMap<string, readonly (readonly [principal: string, identity: string])[]>
  /** Every kept row behind each merged answer, so one scope can leave without a rebuild. */
  claimRows: OverlayMap<string, readonly Row[]>
  attachmentRows: OverlayMap<string, OverlayMap<string, readonly Row[]>>
  /** Kept attachment rows per home principal; a principal leaves both maps at zero. */
  attachmentCounts: OverlayMap<string, number>
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

/** Lists by key: a list is copied on the draft's first write to it, and removals are applied
 *  once per list when the draft finishes, so removing many values from one list stays linear. */
class DraftLists<K, T> {
  private readonly map: OverlayMapDraft<K, readonly T[]>
  private readonly owned = new Map<K, T[]>()
  private readonly removals = new Map<K, Map<unknown, number>>()

  constructor(
    base: OverlayMap<K, readonly T[]>,
    private readonly identify: (value: T) => unknown = (value) => value
  ) {
    this.map = base.edit()
  }

  get(id: K): readonly T[] | undefined {
    return this.map.get(id)
  }

  add(id: K, value: T): void {
    this.own(id).push(value)
  }

  remove(id: K, value: T): void {
    this.own(id)
    const counts = this.removals.get(id) ?? new Map<unknown, number>()
    const key = this.identify(value)
    this.removals.set(id, counts.set(key, (counts.get(key) ?? 0) + 1))
  }

  /** Applies the pending removals; call before reading lists that had any. */
  settle(): void {
    for (const [id, counts] of this.removals) {
      const list = this.own(id).filter((value) => {
        const key = this.identify(value)
        const count = counts.get(key) ?? 0
        if (count > 0) {
          counts.set(key, count - 1)
          return false
        }
        return true
      })
      this.owned.set(id, list)
      if (list.length === 0) {
        this.map.delete(id)
      } else {
        this.map.set(id, list)
      }
    }
    this.removals.clear()
  }

  finish(): OverlayMap<K, readonly T[]> {
    this.settle()
    return this.map.finish()
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

const attachedPaneKey = ([principal, identity]: readonly [string, string]) =>
  JSON.stringify([principal, identity])

/** A copy of a host part that adds and removes kept rows and principals, sharing every map and
 *  list it does not touch, then re-merges only the identities whose rows moved. */
export class HostPartDraft {
  private readonly claimRows: DraftLists<string, Row>
  private readonly attachmentRows: OverlayMapDraft<string, OverlayMap<string, readonly Row[]>>
  private readonly attachmentCounts: OverlayMapDraft<string, number>
  private readonly attachmentBuckets = new Map<string, DraftLists<string, Row>>()
  private readonly principals: Map<string, number>
  private readonly panes: DraftLists<string, string>
  private readonly attachedPanes: DraftLists<string, readonly [string, string]>
  private readonly touchedClaims = new Set<string>()
  private readonly touchedAttachments = new Map<string, Set<string>>()

  constructor(
    private readonly base: HostPart | undefined,
    private readonly onRow: () => void
  ) {
    this.claimRows = new DraftLists(base?.claimRows ?? OverlayMap.empty())
    this.attachmentRows = (base?.attachmentRows ?? OverlayMap.empty()).edit()
    this.attachmentCounts = (base?.attachmentCounts ?? OverlayMap.empty()).edit()
    this.principals = new Map(base?.principals)
    this.panes = new DraftLists(base?.panes ?? OverlayMap.empty())
    this.attachedPanes = new DraftLists(base?.attachedPanes ?? OverlayMap.empty(), attachedPaneKey)
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
          this.claimRows.remove(row.identity, row)
          this.panes.remove(paneId(row), row.identity)
        }
      }
    }
    for (const [principal, row] of rows.attachments) {
      if (kept(row)) {
        this.onRow()
        const touched = this.touchedAttachments.get(principal) ?? new Set<string>()
        this.touchedAttachments.set(principal, touched.add(row.identity))
        const bucket = this.attachmentBucket(principal)
        this.attachmentCounts.set(principal, (this.attachmentCounts.get(principal) ?? 0) + sign)
        if (sign > 0) {
          bucket.add(row.identity, row)
          this.attachedPanes.add(paneId(row), [principal, row.identity])
        } else {
          bucket.remove(row.identity, row)
          this.attachedPanes.remove(paneId(row), [principal, row.identity])
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
    this.claimRows.settle()
    const identities = (this.base?.identities ?? OverlayMap.empty<string, Located>()).edit()
    for (const identity of this.touchedClaims) {
      const value = fold(this.claimRows.get(identity) ?? [])
      if (value === undefined) {
        identities.delete(identity)
      } else {
        identities.set(identity, value)
      }
    }
    const attachments = (this.base?.attachments ?? OverlayMap.empty()).edit()
    for (const [principal, touched] of this.touchedAttachments) {
      const rows = this.attachmentBuckets.get(principal)!
      if (!this.attachmentCounts.get(principal)) {
        this.attachmentCounts.delete(principal)
        this.attachmentRows.delete(principal)
        attachments.delete(principal)
        continue
      }
      rows.settle()
      const bucket = (attachments.get(principal) ?? OverlayMap.empty<string, Located>()).edit()
      for (const identity of touched) {
        const value = fold(rows.get(identity) ?? [])
        if (value === undefined) {
          bucket.delete(identity)
        } else {
          bucket.set(identity, value)
        }
      }
      attachments.set(principal, bucket.finish())
      this.attachmentRows.set(principal, rows.finish())
    }
    return {
      identities: identities.finish(),
      principals: this.principals,
      attachments: attachments.finish(),
      panes: this.panes.finish(),
      attachedPanes: this.attachedPanes.finish(),
      claimRows: this.claimRows.finish(),
      attachmentRows: this.attachmentRows.finish(),
      attachmentCounts: this.attachmentCounts.finish()
    }
  }

  private attachmentBucket(principal: string): DraftLists<string, Row> {
    let bucket = this.attachmentBuckets.get(principal)
    if (!bucket) {
      bucket = new DraftLists(this.attachmentRows.get(principal) ?? OverlayMap.empty())
      this.attachmentBuckets.set(principal, bucket)
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
