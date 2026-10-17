import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  getActiveStickyHeaderIndex,
  getPreviousStickyHeaderIndex,
  getVirtualRowIndex
} from '../sidebar/worktree-list/viewport/virtual-rows'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'

export const VAULT_GROUP_HEADER_ROW_HEIGHT = 32
export const VAULT_SESSION_ROW_HEIGHT = 98
export const VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT = 420

export type AiVaultListRow =
  | { type: 'group'; group: AiVaultSessionListGroup & { label: string } }
  | { type: 'session'; groupKey: string; session: AiVaultSession }

export type VaultVirtualRow = { type: 'group' | 'session' }

export function getVaultRowKey(row: AiVaultListRow): string {
  return row.type === 'group' ? `group:${row.group.key}` : `session:${row.session.id}`
}

export function getVaultRowElementKey(element: Element): string | null {
  return element.getAttribute('data-vault-virtual-row-key')
}

export function isCurrentVaultVirtualRowElement(
  element: Element,
  vaultRows: readonly AiVaultListRow[]
): boolean {
  if (!element.isConnected) {
    return false
  }
  const index = getVirtualRowIndex(element)
  if (index === null) {
    return false
  }
  const row = vaultRows[index]
  if (!row) {
    return false
  }
  return getVaultRowElementKey(element) === getVaultRowKey(row)
}

export function estimateVaultRowSize(
  row: AiVaultListRow | undefined,
  expandedSessionIds?: ReadonlySet<string>
): number {
  if (row?.type === 'group') {
    return VAULT_GROUP_HEADER_ROW_HEIGHT
  }
  if (row?.type === 'session' && expandedSessionIds?.has(row.session.id)) {
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
