import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getWorktreeCardStyle } from '../../../../../../shared/worktree/card-style'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { buildWorktreeLineageRanges } from '../../../../../../shared/sidebar-list/worktree-lineage-range'
import type { WorktreeOccurrencePlan } from '../../../../../../shared/worktree-occurrence-plan'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import {
  resolveWorktreeCardOpen,
  selectCardSelection,
  EMPTY_CARD_SELECTION,
  useCardDisclosures,
  type CardDisclosure,
  type CardSelection
} from '../../workspace-card/surface/worktree-card-open-state'
import type { HostScopedWorktreeKey } from '../../../../../../shared/worktree/host-qualified-identity'

type Ranges = ReturnType<typeof buildWorktreeLineageRanges>
const NO_CARDS = new Map<HostScopedWorktreeKey, CardDisclosure>()

/** Fold before keyboard navigation, reveal lookup and virtual rows consume the sidebar. */
export function projectCardDisclosureRows(
  rows: HostSectionRow[],
  ranges: Ranges,
  cards: ReadonlyMap<HostScopedWorktreeKey, CardDisclosure>,
  selection: CardSelection
): HostSectionRow[] {
  const result: HostSectionRow[] = []
  let hiddenBelow: { section: string; depth: number } | undefined
  for (const row of rows) {
    if (row.type !== 'item' && row.type !== 'folder-workspace') {
      hiddenBelow = undefined
      result.push(row)
      continue
    }
    const section = row.type === 'item' ? row.sectionKey : row.occurrence?.sectionKey
    if (hiddenBelow && section === hiddenBelow.section && row.depth > hiddenBelow.depth) {
      continue
    }
    hiddenBelow = undefined
    const source = ranges.get(row.type === 'item' ? row.rowKey : (row.occurrence?.key ?? row.key))
    const identity = getWorktreeHostIdentity(
      row.type === 'item' ? row.worktree : folderWorkspaceToWorktree(row.folderWorkspace)
    )
    const open = resolveWorktreeCardOpen(identity, source, cards.get(identity), selection)
    if (!open && section) {
      hiddenBelow = { section, depth: row.depth }
    }
    result.push({
      ...row,
      lineageDescendantIdentities: source,
      lineageDescendantsHidden: !open || row.lineageCollapsed === true
    })
  }
  return result
}

export function useCardDisclosureRows(
  rows: HostSectionRow[],
  plan: WorktreeOccurrencePlan<Worktree>
): HostSectionRow[] {
  const enabled = useAppStore((s) => getWorktreeCardStyle(s.settings) === 'experimental-2')
  const cards = useCardDisclosures((s) => (enabled ? s.cards : NO_CARDS))
  const selection = useAppStore(
    useShallow((s) => (enabled ? selectCardSelection(s) : EMPTY_CARD_SELECTION))
  )
  const ranges = useMemo(() => (enabled ? buildWorktreeLineageRanges(plan) : null), [enabled, plan])
  useEffect(() => {
    if (!ranges || (!selection.reveal && !selection.revealRow)) {
      return
    }
    // Fulfil the external reveal request before its pending marker is cleared.
    useCardDisclosures.setState(({ cards }) => {
      let next: Map<HostScopedWorktreeKey, CardDisclosure> | undefined
      const revealSelection = { ...selection, active: null, sendTarget: undefined }
      for (const source of ranges.values()) {
        const identity = source.tree.identities[source.index]!
        if (
          !cards.get(identity)?.open &&
          resolveWorktreeCardOpen(identity, source, undefined, revealSelection)
        ) {
          next ??= new Map(cards)
          next.set(identity, { open: true, closedOver: null })
        }
      }
      return next ? { cards: next } : useCardDisclosures.getState()
    })
  }, [ranges, selection])
  return useMemo(
    () => (ranges ? projectCardDisclosureRows(rows, ranges, cards, selection) : rows),
    [rows, ranges, cards, selection]
  )
}
