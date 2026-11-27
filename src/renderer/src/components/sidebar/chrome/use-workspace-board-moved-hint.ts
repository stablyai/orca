import React from 'react'
import { useAppStore } from '@/store'
import { useOrcaWindowForegroundFocused } from '@/attention/use-orca-window-foreground-focused'
import { selectRailPageHidesWorkspaceList } from '@/components/app-rail/app-rail-layout'

export const WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY = 'orca.workspaceBoardMovedHintSeen.v1'
export const WORKSPACE_BOARD_MOVED_HINT_DURATION_MS = 12000
// Covers the bubble's fade-out (tooltip exit animations run 150 ms) so no hover label opens under it.
export const WORKSPACE_BOARD_MOVED_HINT_EXIT_MS = 200

/**
 * pending: waiting for persisted UI. ineligible: never shows this session.
 * idle: eligible, waiting for a focused window. showing → leaving (fading out, seen key written) → done.
 */
type MovedHintPhase = 'pending' | 'ineligible' | 'idle' | 'showing' | 'leaving' | 'done'

function readHintSeen(): boolean {
  try {
    return window.localStorage.getItem(WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY) === 'true'
  } catch {
    // No storage means the seen flag can never be kept; skip the hint rather than repeat it.
    return true
  }
}

function writeHintSeen(): void {
  try {
    window.localStorage.setItem(WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY, 'true')
  } catch {
    // Best effort: a lost write only means the hint can show once more.
  }
}

export type WorkspaceBoardMovedHint = {
  showing: boolean
  /** False while a rail page (e.g. Tasks) hides the workspace list and its board button. */
  listVisible: boolean
  /** Showing or still fading out: the board's own hover label must stay unmounted. */
  labelSuppressed: boolean
  hide: () => void
}

/**
 * Drives the one-time "board moved" hint. The toolbar only mounts while the sidebar is open: closing the
 * sidebar unmounts it, which marks the hint seen. With the app rail, a rail page (Tasks, ...) keeps the
 * toolbar mounted but hides the list, so the hint also waits for (and yields to) a visible list.
 */
export function useWorkspaceBoardMovedHint(): WorkspaceBoardMovedHint {
  const [phase, setPhase] = React.useState<MovedHintPhase>('pending')
  const phaseRef = React.useRef(phase)
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const boardUsedBeforeLaunch = useAppStore((state) => state.workspaceBoardUsedBeforeLaunch)
  const windowFocused = useOrcaWindowForegroundFocused(phase === 'idle')
  const listVisible = !useAppStore(selectRailPageHidesWorkspaceList)

  React.useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // Only users who had opened the board before this launch are told it moved. The store decides that once
  // at load, so opening it now and remounting the sidebar never makes a new user eligible.
  React.useEffect(() => {
    if (phase === 'pending' && persistedUIReady && boardUsedBeforeLaunch !== null) {
      setPhase(boardUsedBeforeLaunch && !readHintSeen() ? 'idle' : 'ineligible')
    }
  }, [boardUsedBeforeLaunch, persistedUIReady, phase])

  // Start only in a focused window with the board button on screen, so the 12 s are not spent unseen.
  React.useEffect(() => {
    if (phase === 'idle' && windowFocused && listVisible) {
      setPhase(readHintSeen() ? 'done' : 'showing')
    }
  }, [listVisible, phase, windowFocused])

  // Leaving for a rail page mid-display hides the hint without counting it as seen; it starts over
  // (a fresh 12 s) once the list is visible again.
  React.useEffect(() => {
    if (phase === 'showing' && !listVisible) {
      phaseRef.current = 'idle'
      setPhase('idle')
    }
  }, [listVisible, phase])

  const hide = React.useCallback(() => {
    if (phaseRef.current !== 'showing') {
      return
    }
    // Seen is recorded when the hint goes away, never before it was visible.
    writeHintSeen()
    phaseRef.current = 'leaving'
    setPhase('leaving')
  }, [])

  // Keyed on the phase alone: a remount or StrictMode re-run re-arms the timer, so it cannot stick open.
  React.useEffect(() => {
    if (phase !== 'showing') {
      return
    }
    const timeoutId = window.setTimeout(hide, WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
    return () => window.clearTimeout(timeoutId)
  }, [hide, phase])

  React.useEffect(() => {
    if (phase !== 'leaving') {
      return
    }
    const timeoutId = window.setTimeout(() => setPhase('done'), WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
    return () => window.clearTimeout(timeoutId)
  }, [phase])

  // Another window that already showed the hint settles it here too.
  const waiting = phase === 'idle' || phase === 'showing'
  React.useEffect(() => {
    if (!waiting) {
      return
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY && event.newValue === 'true') {
        // A local dismissal may already be fading out: keep that exit (and its label suppression) intact.
        if (phaseRef.current === 'showing' || phaseRef.current === 'idle') {
          phaseRef.current = phaseRef.current === 'showing' ? 'leaving' : 'done'
          setPhase(phaseRef.current)
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [waiting])

  // Unmounting while visible (the sidebar closed) counts as seen. Mount-only so a phase change never writes.
  React.useEffect(
    () => () => {
      if (phaseRef.current === 'showing') {
        writeHintSeen()
      }
    },
    []
  )

  return {
    showing: phase === 'showing',
    listVisible,
    labelSuppressed: phase === 'showing' || phase === 'leaving',
    hide
  }
}
