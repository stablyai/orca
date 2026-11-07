import { useCallback } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  isLineageRange,
  type WorktreeLineageSource
} from '../../../../../../shared/sidebar-list/worktree-lineage-range'

export type CardDisclosure = { open: boolean; closedOver: HostScopedWorktreeKey | null }
export const useCardDisclosures = create<{
  cards: ReadonlyMap<HostScopedWorktreeKey, CardDisclosure>
}>(() => ({ cards: new Map() }))

export function setWorktreeCardDisclosure(
  identity: HostScopedWorktreeKey,
  disclosure: CardDisclosure
): void {
  useCardDisclosures.setState(({ cards }) => {
    const next = new Map(cards)
    next.delete(identity)
    next.set(identity, disclosure)
    if (next.size > 512) {
      next.delete(next.keys().next().value!)
    }
    return { cards: next }
  })
}

export function selectCardSelection(state: AppState) {
  return {
    active: state.activeWorktreeId
      ? composeWorktreeHostIdentity(
          state.activeWorkspaceExecutionHostId ?? undefined,
          state.activeWorktreeId
        )
      : null,
    reveal: state.pendingRevealWorktree,
    revealRow: state.pendingRevealSidebarRow?.rowKey,
    sendTarget: state.agentSendPopoverTargetMode?.worktreeId
  }
}
export type CardSelection = ReturnType<typeof selectCardSelection>
export const EMPTY_CARD_SELECTION: CardSelection = {
  active: null,
  reveal: null,
  revealRow: undefined,
  sendTarget: undefined
}

function contains(
  source: WorktreeLineageSource | undefined,
  identity: HostScopedWorktreeKey | null
): boolean {
  if (!source || !identity) {
    return false
  }
  if (isLineageRange(source)) {
    const index = getExecutionHostIdFromWorktreeHostIdentity(identity)
      ? source.tree.indexByIdentity.get(identity)
      : source.tree.indexByWorktreeId.get(getWorktreeIdFromHostIdentity(identity))
    return index != null && index > source.index && index < source.tree.ends[source.index]!
  }
  return source.includes(identity)
}

export function resolveWorktreeCardOpen(
  identity: HostScopedWorktreeKey,
  source: WorktreeLineageSource | undefined,
  disclosure: CardDisclosure | undefined,
  selection: CardSelection
): boolean {
  if (disclosure?.open) {
    return true
  }
  if (selection.active !== disclosure?.closedOver && contains(source, selection.active)) {
    return true
  }
  const reveal = selection.reveal
  if (
    reveal &&
    contains(source, composeWorktreeHostIdentity(reveal.executionHostId, reveal.worktreeId))
  ) {
    return true
  }
  if (source && isLineageRange(source) && selection.revealRow) {
    const range = source.tree.rangesByOccurrence.get(selection.revealRow)
    if (
      range?.tree === source.tree &&
      range.index > source.index &&
      range.index < source.tree.ends[source.index]!
    ) {
      return true
    }
  }
  if (selection.sendTarget) {
    if (getWorktreeIdFromHostIdentity(identity) === selection.sendTarget) {
      return true
    }
    if (source && isLineageRange(source)) {
      const index = source.tree.indexByWorktreeId.get(selection.sendTarget)
      if (index != null && index > source.index && index < source.tree.ends[source.index]!) {
        return true
      }
    } else if (
      source?.some((child) => getWorktreeIdFromHostIdentity(child) === selection.sendTarget)
    ) {
      return true
    }
  }
  return false
}

/** The surface and list projection resolve the same disclosure, including host-qualified reveals. */
export function useWorktreeCardOpen(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  source: WorktreeLineageSource | undefined,
  enabled = true
): { open: boolean; toggle: () => void } {
  const identity = getWorktreeHostIdentity(worktree)
  const disclosure = useCardDisclosures((s) => (enabled ? s.cards.get(identity) : undefined))
  const selection = useAppStore(
    useShallow((s) => (enabled ? selectCardSelection(s) : EMPTY_CARD_SELECTION))
  )
  const open = resolveWorktreeCardOpen(identity, source, disclosure, selection)
  const toggle = useCallback(
    () =>
      setWorktreeCardDisclosure(identity, {
        open: !open,
        closedOver: open ? selection.active : null
      }),
    [identity, open, selection.active]
  )
  return { open, toggle }
}
