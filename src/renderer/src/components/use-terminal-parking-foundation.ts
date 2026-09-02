import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'
import { useActiveTerminalRepair } from './terminal/use-active-terminal-repair'
import { scheduleBackgroundTerminalWorktreeMeasure } from './terminal/background-terminal-worktree-visibility'
import {
  applyBackgroundMountTabRestriction,
  revealActivationDeferredTabs,
  takeAllPendingBackgroundTerminalWorktreeMounts,
  takePendingBackgroundTerminalWorktreeMount
} from './terminal/background-terminal-worktree-mount'
import {
  combineTerminalWorktreeParkIds,
  useManualTerminalWorktreeParking
} from './terminal-pane/use-manual-terminal-worktree-parking'
import type { TerminalEditorCloseController } from './use-terminal-editor-close-dialog-actions'

export function useTerminalParkingFoundation(controller: TerminalEditorCloseController) {
  const {
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeView,
    closeDialogDebounceTimersRef,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    setActiveTab,
    tabs,
    terminalWorktreeParkingTimersRef
  } = controller

  useActiveTerminalRepair({
    activeTabId,
    activeTabType,
    setActiveTab,
    tabs,
    activeTabIdByWorktree,
    renderedActiveWorktreeId
  })

  const measurableBackgroundWorktreeTimersRef = useRef(new Map<string, number>())
  const [backgroundMountRevision, setBackgroundMountRevision] = useState(0)
  const [terminalParkingRevision, setTerminalParkingRevision] = useState(0)
  const [browserGuestRetentionRevision, setBrowserGuestRetentionRevision] = useState(0)
  const [parkedTerminalWorktreeIds, setParkedTerminalWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const manuallyParkedTerminalWorktreeIds = useManualTerminalWorktreeParking({
    activeView,
    renderedActiveWorktreeId
  })
  const effectiveParkedTerminalWorktreeIds = useMemo(
    () =>
      combineTerminalWorktreeParkIds(parkedTerminalWorktreeIds, manuallyParkedTerminalWorktreeIds),
    [manuallyParkedTerminalWorktreeIds, parkedTerminalWorktreeIds]
  )
  const [forceParkedTerminalWorktreeIds, setForceParkedTerminalWorktreeIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [evictionExemptTerminalTabIds, setEvictionExemptTerminalTabIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const forceParkedCaptureDoneRef = useRef(new Set<string>())
  const backgroundMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  const activationDeferredMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  const lastActivationWorktreeIdRef = useRef<string | null>(null)

  useEffect(() => {
    const timers = measurableBackgroundWorktreeTimersRef.current
    const closeDialogDebounceTimers = closeDialogDebounceTimersRef.current
    const applyBackgroundMount = (detail: BackgroundMountTerminalWorktreeDetail): void => {
      const worktreeId = detail.worktreeId
      applyBackgroundMountTabRestriction(
        backgroundMountTabIdsByWorktreeRef.current,
        mountedWorktreeIdsRef.current,
        worktreeId,
        detail.tabIds
      )
      const worktreeTabIds = (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map(
        (tab) => tab.id
      )
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId,
        allTabIds: worktreeTabIds,
        immediateTabIds: new Set(detail.tabIds ?? worktreeTabIds)
      })
      scheduleBackgroundTerminalWorktreeMeasure({
        mountedWorktreeIds: mountedWorktreeIdsRef.current,
        measurableBackgroundWorktreeIds: measurableBackgroundWorktreeIdsRef.current,
        timers,
        worktreeId,
        onRevision: () => setBackgroundMountRevision((revision) => revision + 1),
        setTimeoutFn: window.setTimeout,
        clearTimeoutFn: window.clearTimeout
      })
    }
    const onBackgroundMountTerminalWorktree = (event: Event): void => {
      const customEvent = event as CustomEvent<BackgroundMountTerminalWorktreeDetail>
      const worktreeId = customEvent.detail?.worktreeId
      const pending = takePendingBackgroundTerminalWorktreeMount(worktreeId)
      const detail = pending ?? customEvent.detail
      if (detail?.worktreeId) {
        applyBackgroundMount(detail)
      }
    }
    window.addEventListener(
      BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
      onBackgroundMountTerminalWorktree as EventListener
    )
    for (const pending of takeAllPendingBackgroundTerminalWorktreeMounts()) {
      applyBackgroundMount(pending)
    }
    return () => {
      window.removeEventListener(
        BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        onBackgroundMountTerminalWorktree as EventListener
      )
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
      for (const timer of closeDialogDebounceTimers) {
        window.clearTimeout(timer)
      }
      closeDialogDebounceTimers.clear()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [])

  useEffect(() => {
    const timers = terminalWorktreeParkingTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the controller ref preserves its original stable identity.
  }, [])

  return {
    measurableBackgroundWorktreeTimersRef,
    backgroundMountRevision,
    setBackgroundMountRevision,
    terminalParkingRevision,
    setTerminalParkingRevision,
    browserGuestRetentionRevision,
    setBrowserGuestRetentionRevision,
    parkedTerminalWorktreeIds,
    setParkedTerminalWorktreeIds,
    manuallyParkedTerminalWorktreeIds,
    effectiveParkedTerminalWorktreeIds,
    forceParkedTerminalWorktreeIds,
    setForceParkedTerminalWorktreeIds,
    evictionExemptTerminalTabIds,
    setEvictionExemptTerminalTabIds,
    forceParkedCaptureDoneRef,
    backgroundMountTabIdsByWorktreeRef,
    activationDeferredMountTabIdsByWorktreeRef,
    lastActivationWorktreeIdRef
  }
}

export type TerminalParkingFoundation = TerminalEditorCloseController &
  ReturnType<typeof useTerminalParkingFoundation>
