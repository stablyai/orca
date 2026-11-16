import { replaceTabBuckets } from '@/store/keyed-record-transitions'
import { getFirstTerminalTabOwnerWorktreeId } from '../ownership/terminal-tab-owner-index'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'

export function getPendingActivationSpawnCount(value: boolean | number | undefined): number {
  if (value === true) {
    return 1
  }
  return typeof value === 'number' && value > 0 ? value : 0
}

export function consumePendingActivationSpawn(
  value: boolean | number | undefined
): boolean | number | undefined {
  const count = getPendingActivationSpawnCount(value)
  if (count <= 1) {
    return undefined
  }
  return count === 2 ? true : count - 1
}

export function getTabIdFromPaneKey(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

export function sortedUniquePtyIds(ptyIds: readonly string[] | undefined): string[] {
  return [...new Set((ptyIds ?? []).filter((ptyId) => ptyId.length > 0))].sort()
}

export function equalStringSets(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const bSet = new Set(b)
  return a.every((value) => bSet.has(value))
}

export function uniquePtyIds(ptyIds: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ptyIds.filter((ptyId): ptyId is string => Boolean(ptyId)))]
}

export function resolvePrimaryLayoutPtyId(layout: TerminalLayoutSnapshot): string | null {
  const ptyIdsByLeafId = layout.ptyIdsByLeafId ?? {}
  const activePtyId = layout.activeLeafId ? ptyIdsByLeafId[layout.activeLeafId] : undefined
  return activePtyId ?? Object.values(ptyIdsByLeafId)[0] ?? null
}

export function withTerminalTabPtyIds(
  tabsByWorktree: Record<string, TerminalTab[]>,
  changes: readonly { tabId: string; ptyId: string | null }[]
): Record<string, TerminalTab[]> {
  const replacements = new Map<string, TerminalTab[]>()
  for (const { tabId, ptyId } of changes) {
    const worktreeId = getFirstTerminalTabOwnerWorktreeId(tabsByWorktree, tabId)
    if (!worktreeId) {
      continue
    }
    const tabs = replacements.get(worktreeId) ?? tabsByWorktree[worktreeId] ?? []
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1 || tabs[index]?.ptyId === ptyId) {
      continue
    }
    const nextTabs = [...tabs]
    nextTabs[index] = { ...nextTabs[index]!, ptyId }
    replacements.set(worktreeId, nextTabs)
  }
  return replacements.size > 0 ? replaceTabBuckets(tabsByWorktree, replacements) : tabsByWorktree
}
