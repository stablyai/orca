import type { IpynbCell } from './ipynb-parse'

export function getIpynbCellKey(cell: IpynbCell, index: number): string {
  return cell.id ?? `${index}:${cell.kind}`
}

export type IpynbSourceDraftBase = { source: string; cellKinds: readonly IpynbCell['kind'][] }

export type IpynbSourceDraftRebase = {
  updates: { key: string; index: number; source: string }[]
  /** Drafts whose cell changed or vanished since the draft began. */
  dropped: string[]
  /** A dropped draft held typing that never reached the shared text. */
  lostTyping: boolean
}

/** Applies each draft onto the latest cells unless another writer changed its cell first. */
export function rebaseIpynbSourceDrafts(
  cells: readonly IpynbCell[],
  drafts: Record<string, string>,
  bases: Record<string, IpynbSourceDraftBase>
): IpynbSourceDraftRebase {
  const result: IpynbSourceDraftRebase = { updates: [], dropped: [], lostTyping: false }
  for (const [key, source] of Object.entries(drafts)) {
    const index = cells.findIndex((cell, cellIndex) => getIpynbCellKey(cell, cellIndex) === key)
    const cell = cells[index]
    const base = bases[key]
    // Position keys cannot identify cells reliably after a structural change.
    const unchanged =
      cell !== undefined &&
      base !== undefined &&
      cell.source === base.source &&
      (cell.id !== null ||
        (cells.length === base.cellKinds.length &&
          cells.every((candidate, cellIndex) => candidate.kind === base.cellKinds[cellIndex])))
    if (unchanged) {
      result.updates.push({ key, index, source })
      continue
    }
    result.dropped.push(key)
    if (source !== cell?.source && source !== base?.source) {
      result.lostTyping = true
    }
  }
  return result
}
