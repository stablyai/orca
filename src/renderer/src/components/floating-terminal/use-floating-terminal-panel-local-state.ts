import { useRef, useState } from 'react'
import type { TerminalPaneHandle } from '@/components/terminal-pane/TerminalPane'
import { useMountedRef } from '@/hooks/useMountedRef'
import { ModifierDoubleTapDetector } from '../../../../shared/modifier-double-tap-detector'
import type {
  FloatingTerminalPanelBounds,
  FloatingTerminalPanelBoundsSource,
  FloatingTerminalPanelCommittedBounds
} from './floating-terminal-panel-bounds'
import { readPersistedFloatingTerminalPanelViewState } from './floating-terminal-panel-view-state'
import {
  hasOrchestrationSetupMarker,
  isOrchestrationSetupDismissed
} from '@/lib/orchestration-setup-state'
import { createTerminalPaneHandleRegistry } from './terminal-pane-handle-registry'
import {
  readInitialPanelBounds,
  type FloatingTerminalPanelBoundsState
} from './floating-terminal-panel-initial-bounds'
import { useSettledPanelViewport } from './use-settled-panel-viewport'

export function useFloatingTerminalPanelLocalState() {
  const [cwd, setCwd] = useState<string | null>(null)
  const [markdownCwd, setMarkdownCwd] = useState<string | null>(null)
  const initialBoundsStateRef = useRef<FloatingTerminalPanelBoundsState | null>(null)
  if (initialBoundsStateRef.current === null) {
    initialBoundsStateRef.current = readInitialPanelBounds()
  }
  const initialBoundsState = initialBoundsStateRef.current
  const boundsSourceRef = useRef<FloatingTerminalPanelBoundsSource>(initialBoundsState.source)
  const committedBoundsRef = useRef<FloatingTerminalPanelCommittedBounds>(
    initialBoundsState.committedBounds
  )
  const [bounds, setBounds] = useState(initialBoundsState.renderedBounds)
  const [maximized, setMaximized] = useState(
    () => readPersistedFloatingTerminalPanelViewState()?.maximized === true
  )
  const panelViewportSettled = useSettledPanelViewport()
  const [orchestrationDialogOpen, setOrchestrationDialogOpen] = useState(false)
  const [showOrchestrationSetup, setShowOrchestrationSetup] = useState(
    () => !hasOrchestrationSetupMarker() && !isOrchestrationSetupDismissed()
  )
  const restoreBoundsRef = useRef<FloatingTerminalPanelBoundsState | null>(null)
  const stagedBoundsRef = useRef<FloatingTerminalPanelBounds | null>(null)
  const lastPersistedBoundsRef = useRef<FloatingTerminalPanelCommittedBounds | null>(
    initialBoundsState.source === 'user' ? initialBoundsState.committedBounds : null
  )
  const pendingEditorCloseQueueRef = useRef<string[]>([])
  const pendingReclaimArmByFileIdRef = useRef<Map<string, () => void>>(new Map())
  const saveDialogFileIdRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [terminalPaneRegistry] = useState(() =>
    createTerminalPaneHandleRegistry<TerminalPaneHandle>()
  )
  const doubleTapDetectorRef = useRef<ModifierDoubleTapDetector | null>(null)
  if (!doubleTapDetectorRef.current) {
    // The detector must exist before event handlers are published.
    // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
    doubleTapDetectorRef.current = new ModifierDoubleTapDetector()
  }
  const shortcutFocusFrameRef = useRef<number | null>(null)
  const shortcutFocusTimeoutRef = useRef<number | null>(null)
  const reclaimTerminalInputOnWindowFocusRef = useRef<{
    helper: HTMLElement
    leafId: string | null
  } | null>(null)
  const mountedRef = useMountedRef()
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    bounds: FloatingTerminalPanelBounds
    moved: boolean
  } | null>(null)

  return {
    cwd,
    setCwd,
    markdownCwd,
    setMarkdownCwd,
    boundsSourceRef,
    committedBoundsRef,
    bounds,
    setBounds,
    maximized,
    setMaximized,
    panelViewportSettled,
    orchestrationDialogOpen,
    setOrchestrationDialogOpen,
    showOrchestrationSetup,
    setShowOrchestrationSetup,
    restoreBoundsRef,
    stagedBoundsRef,
    lastPersistedBoundsRef,
    pendingEditorCloseQueueRef,
    pendingReclaimArmByFileIdRef,
    saveDialogFileIdRef,
    panelRef,
    terminalPaneRegistry,
    doubleTapDetectorRef,
    shortcutFocusFrameRef,
    shortcutFocusTimeoutRef,
    reclaimTerminalInputOnWindowFocusRef,
    mountedRef,
    dragRef
  }
}

export type FloatingTerminalPanelLocalState = ReturnType<typeof useFloatingTerminalPanelLocalState>
