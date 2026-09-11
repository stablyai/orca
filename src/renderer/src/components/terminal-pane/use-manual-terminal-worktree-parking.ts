import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'
import {
  MANUAL_TERMINAL_WORKTREE_PARK_EVENT,
  takeAllPendingManualTerminalWorktreeParks,
  takePendingManualTerminalWorktreePark,
  type ManualTerminalWorktreeParkDetail,
  type ManualTerminalWorktreeParkReason
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

function canParkWorktreeOnDemand(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
  return (
    canManuallyParkTerminalWorktreeRenderers({
      worktreeId,
      terminalTabs,
      pendingStartupByTabId: state.pendingStartupByTabId,
      parkingEnabled: state.settings?.terminalHiddenViewParking !== false,
      hasLivePty: (tabId) => tabHasLivePty(state.ptyIdsByTabId, tabId)
    }) && terminalTabs.every((tab) => canWatcherCoverParkedTerminalTab(worktreeId, tab))
  )
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

  const parkWorktree = useCallback(
    (worktreeId: string, reason: ManualTerminalWorktreeParkReason) => {
      // Why sleep skips the gates: they protect live output, and sleep already verified every PTY
      // is gone. Refusing would leave the workspace mounted, and the next unpark would respawn the
      // sessions sleep just killed.
      if (reason !== 'workspace-sleep' && !canParkWorktreeOnDemand(worktreeId)) {
        toast.warning(
          translate(
            'auto.components.terminalPane.useManualTerminalWorktreeParking.cannotPark',
            'These terminals cannot be parked safely.'
          )
        )
        return
      }
      setManuallyParkedWorktreeIds((current) => addWorktreeId(current, worktreeId))
    },
    []
  )

  useEffect(() => {
    const handleParkRequest = (event: Event): void => {
      const detail = (event as CustomEvent<ManualTerminalWorktreeParkDetail>).detail
      if (!detail?.worktreeId) {
        return
      }
      parkWorktree(
        detail.worktreeId,
        takePendingManualTerminalWorktreePark(detail.worktreeId) ?? detail.reason
      )
    }
    window.addEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, handleParkRequest as EventListener)
    for (const pending of takeAllPendingManualTerminalWorktreeParks()) {
      parkWorktree(pending.worktreeId, pending.reason)
    }
    return () =>
      window.removeEventListener(
        MANUAL_TERMINAL_WORKTREE_PARK_EVENT,
        handleParkRequest as EventListener
      )
  }, [parkWorktree])

  useEffect(() => {
    // Why a background mount releases the park: it is a navigation-free wake (mobile, CLI reveal)
    // and only suspends the park for its measure window, so a park left latched would unmount the
    // panes it just woke seconds later.
    const handleBackgroundMount = (event: Event): void => {
      const worktreeId = (event as CustomEvent<BackgroundMountTerminalWorktreeDetail>).detail
        ?.worktreeId
      if (!worktreeId) {
        return
      }
      setManuallyParkedWorktreeIds((current) => removeWorktreeId(current, worktreeId))
    }
    window.addEventListener(
      BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
      handleBackgroundMount as EventListener
    )
    return () =>
      window.removeEventListener(
        BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        handleBackgroundMount as EventListener
      )
  }, [])

  useEffect(() => {
    const revealedWorktreeId = args.renderedActiveWorktreeId
    if (args.activeView !== 'terminal' || !revealedWorktreeId) {
      return
    }
    setManuallyParkedWorktreeIds((current) => removeWorktreeId(current, revealedWorktreeId))
  }, [args.activeView, args.renderedActiveWorktreeId])

  return manuallyParkedWorktreeIds
}
