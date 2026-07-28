import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  MANUAL_TERMINAL_WORKTREE_PARK_EVENT,
  takeAllPendingManualTerminalWorktreeParks,
  takePendingManualTerminalWorktreePark,
  type ManualTerminalWorktreeParkDetail
} from '@/lib/manual-terminal-worktree-parking'
import { canManuallyParkTerminalWorktreeRenderers } from './manual-terminal-worktree-park-eligibility'
import { canWatcherCoverParkedTerminalTab } from './terminal-parked-tab-watchers'

function addWorktreeId(current: ReadonlySet<string>, worktreeId: string): ReadonlySet<string> {
  if (current.has(worktreeId)) {
    return current
  }
  return new Set([...current, worktreeId])
}

function removeWorktreeId(current: ReadonlySet<string>, worktreeId: string): ReadonlySet<string> {
  if (!current.has(worktreeId)) {
    return current
  }
  const next = new Set(current)
  next.delete(worktreeId)
  return next
}

export function combineTerminalWorktreeParkIds(
  automaticIds: ReadonlySet<string>,
  manualIds: ReadonlySet<string>
): ReadonlySet<string> {
  if (manualIds.size === 0) {
    return automaticIds
  }
  return new Set([...automaticIds, ...manualIds])
}

export function useManualTerminalWorktreeParking(args: {
  activeView: string
  renderedActiveWorktreeId: string | null
}): ReadonlySet<string> {
  const [manuallyParkedWorktreeIds, setManuallyParkedWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  const parkWorktree = useCallback((worktreeId: string) => {
    const state = useAppStore.getState()
    const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
    const canPark =
      canManuallyParkTerminalWorktreeRenderers({
        worktreeId,
        terminalTabs,
        pendingStartupByTabId: state.pendingStartupByTabId,
        parkingEnabled: state.settings?.terminalHiddenViewParking !== false,
        hasLivePty: (tabId) => tabHasLivePty(state.ptyIdsByTabId, tabId)
      }) && terminalTabs.every((tab) => canWatcherCoverParkedTerminalTab(worktreeId, tab))
    if (!canPark) {
      toast.warning(
        translate(
          'auto.components.terminalPane.useManualTerminalWorktreeParking.cannotPark',
          'These terminals cannot be parked safely.'
        )
      )
      return
    }
    setManuallyParkedWorktreeIds((current) => addWorktreeId(current, worktreeId))
  }, [])

  useEffect(() => {
    const handleParkRequest = (event: Event): void => {
      const worktreeId = (event as CustomEvent<ManualTerminalWorktreeParkDetail>).detail?.worktreeId
      if (!worktreeId) {
        return
      }
      takePendingManualTerminalWorktreePark(worktreeId)
      parkWorktree(worktreeId)
    }
    window.addEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, handleParkRequest as EventListener)
    for (const worktreeId of takeAllPendingManualTerminalWorktreeParks()) {
      parkWorktree(worktreeId)
    }
    return () =>
      window.removeEventListener(
        MANUAL_TERMINAL_WORKTREE_PARK_EVENT,
        handleParkRequest as EventListener
      )
  }, [parkWorktree])

  useEffect(() => {
    const revealedWorktreeId = args.renderedActiveWorktreeId
    if (args.activeView !== 'terminal' || !revealedWorktreeId) {
      return
    }
    setManuallyParkedWorktreeIds((current) => removeWorktreeId(current, revealedWorktreeId))
  }, [args.activeView, args.renderedActiveWorktreeId])

  return manuallyParkedWorktreeIds
}
