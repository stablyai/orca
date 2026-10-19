import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import {
  getActiveStickyHeaderIndex,
  getPreviousStickyHeaderIndex
} from '../sidebar/worktree-list/viewport/virtual-rows'

export const VAULT_GROUP_HEADER_ROW_HEIGHT = 32
export const VAULT_SESSION_ROW_HEIGHT = 98
export const VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT = 420

export type VaultVirtualRow =
  | { type: 'group'; group: { key: string } }
  | { type: 'session'; session: { id: string } }

export function getVaultVirtualRowKey(row: VaultVirtualRow | undefined, index: number): string {
  if (!row) {
    return `missing:${index}`
  }
  return row.type === 'group' ? `group:${row.group.key}` : `session:${row.session.id}`
}

export function estimateVaultVirtualRowSize(
  row: VaultVirtualRow | undefined,
  expandedSessionIds: ReadonlySet<string>
): number {
  if (row?.type === 'group') {
    return VAULT_GROUP_HEADER_ROW_HEIGHT
  }
  if (row?.type === 'session' && expandedSessionIds.has(row.session.id)) {
    return VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT
  }
  return VAULT_SESSION_ROW_HEIGHT
}

export function getVaultStickyHeaderIndexes(rows: readonly VaultVirtualRow[]): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    if (row.type === 'group') {
      indexes.push(index)
    }
  })
  return indexes
}

export function extractVaultVirtualRowIndexes(args: {
  range: Range
  stickyHeaderIndexes: readonly number[]
}): number[] {
  const activeStickyHeaderIndex = getActiveStickyHeaderIndex(
    args.stickyHeaderIndexes,
    args.range.startIndex
  )
  if (activeStickyHeaderIndex === null) {
    return defaultRangeExtractor(args.range)
  }

  const previousStickyHeaderIndex = getPreviousStickyHeaderIndex(
    args.stickyHeaderIndexes,
    activeStickyHeaderIndex
  )
  return Array.from(
    new Set([
      activeStickyHeaderIndex,
      ...(previousStickyHeaderIndex === null ? [] : [previousStickyHeaderIndex]),
      ...defaultRangeExtractor(args.range)
    ])
  ).sort((a, b) => a - b)
}
