import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import {
  getActiveStickyHeaderIndex,
  getPreviousStickyHeaderIndex
} from '../sidebar/worktree-list-virtual-rows'

export const VAULT_GROUP_HEADER_ROW_HEIGHT = 32
export const VAULT_SESSION_ROW_HEIGHT = 64

export type VaultVirtualRow = { type: 'group' | 'session' }

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
