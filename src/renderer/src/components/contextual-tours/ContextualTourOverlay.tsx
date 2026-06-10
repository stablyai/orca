import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '@/store'
import {
  getContextualTour,
  type ContextualTourId,
  type ContextualTourStepAction
} from '../../../../shared/contextual-tours'
import type { ContextualTourOutcome } from '../../../../shared/feature-education-telemetry'
import {
  trackContextualTourOutcome,
  trackContextualTourShown
} from '@/lib/feature-education-telemetry'
import { isContextualTourAllowedForModal } from './contextual-tour-gate'
import {
  getContextualTourCleanupOutcome,
  measureContextualTourOverlayRenderState
} from './contextual-tour-overlay-measurement'
import { getContextualTourOverlayPanelPosition } from './contextual-tour-overlay-position'
import {
  ContextualTourOverlaySurface,
  getContextualTourFocusableElements,
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'
import {
  REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
  type RequestActiveTerminalPaneSplitDetail
} from '@/constants/terminal'
import { performContextualTourStepAction } from './contextual-tour-step-actions'
import { openWorkspaceCreationComposerWithTourHandoff } from './workspace-creation-tour-handoff'

export function ContextualTourOverlay(): JSX.Element | null {
  const activeTourId = useAppStore((s) => s.activeContextualTourId)
  const activeStepIndex = useAppStore((s) => s.activeContextualTourStepIndex)
  const activeTourSource = useAppStore((s) => s.activeContextualTourSource)
  const wasFeaturePreviouslyInteracted = useAppStore(
    (s) => s.activeContextualTourWasFeaturePreviouslyInteracted
  )
  const activeModal = useAppStore((s) => s.activeModal)
  const onboardingVisible = useAppStore((s) => s.contextualToursOnboardingVisible)
  const blockingSurfaceVisible = useAppStore((s) => s.contextualToursBlockingSurfaceVisible)
  const activeTourSuppressed = useAppStore((s) => s.activeContextualTourSuppressed)
  const keybindings = useAppStore((s) => s.keybindings)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const canCreateWorkspace = useAppStore((s) => s.repos.length > 0)
  const markContextualToursSeen = useAppStore((s) => s.markContextualToursSeen)
  const advanceContextualTour = useAppStore((s) => s.advanceContextualTour)
  const regressContextualTour = useAppStore((s) => s.regressContextualTour)
  const dismissContextualTour = useAppStore((s) => s.dismissContextualTour)
  const completeContextualTour = useAppStore((s) => s.completeContextualTour)
  const cancelContextualTour = useAppStore((s) => s.cancelContextualTour)
  const detachContextualTourSource = useAppStore((s) => s.detachContextualTourSource)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openModal = useAppStore((s) => s.openModal)
  const [renderState, setRenderState] = useState<ActiveTourRenderState | null>(null)
  const [measureVersion, setMeasureVersion] = useState(0)
  const panelRef = useRef<HTMLElement | null>(null)
  const markedTourIdRef = useRef<string | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusedStepRef = useRef<string | null>(null)
  const telemetryTourIdRef = useRef<ContextualTourId | null>(null)
  const telemetryOutcomeSentRef = useRef(false)
  const telemetryStepsSeenRef = useRef<Set<number>>(new Set())
  const telemetryTotalStepsRef = useRef(1)
  const telemetryFurthestStepIndexRef = useRef(0)
  const telemetryDefinedStepCountRef = useRef(1)

  const activeTour = useMemo(
    () => (activeTourId ? getContextualTour(activeTourId) : null),
    [activeTourId]
  )

  const emitContextualTourOutcome = useCallback(
    (outcome: ContextualTourOutcome): void => {
      if (
        !activeTourId ||
        telemetryOutcomeSentRef.current ||
        telemetryTourIdRef.current !== activeTourId
      ) {
        return
      }
      telemetryOutcomeSentRef.current = true
      const furthestStepIndex = telemetryFurthestStepIndexRef.current
      trackContextualTourOutcome({
        tourId: activeTourId,
        source: activeTourSource,
        outcome,
        stepsSeen: telemetryStepsSeenRef.current.size,
        totalSteps: telemetryTotalStepsRef.current,
        ...(furthestStepIndex > 0
          ? {
              furthestStepIndex,
              definedStepCount: telemetryDefinedStepCountRef.current
            }
          : {})
      })
    },
    [activeTourId, activeTourSource]
  )

  useLayoutEffect(() => {
    if (!activeTourId) {
      setRenderState(null)
      return
    }
    // Why: reset before the measurement layout effect below, otherwise the
    // first passive effect can hide a freshly measured tour until the next tick.
    markedTourIdRef.current = null
    telemetryTourIdRef.current = null
    telemetryOutcomeSentRef.current = false
    telemetryStepsSeenRef.current = new Set()
    telemetryTotalStepsRef.current = 1
    telemetryFurthestStepIndexRef.current = 0
    telemetryDefinedStepCountRef.current = activeTour?.steps.length ?? 1
    setRenderState(null)
  }, [activeTour?.steps.length, activeTourId])

  useEffect(() => {
    if (!activeTour || !activeTourId) {
      return
    }
    if (
      onboardingVisible ||
      blockingSurfaceVisible ||
      activeTourSuppressed ||
      !isContextualTourAllowedForModal(activeTour, activeModal)
    ) {
      emitContextualTourOutcome('cancelled')
      cancelContextualTour(activeTourId)
    }
  }, [
    activeModal,
    activeTourSuppressed,
    activeTour,
    activeTourId,
    blockingSurfaceVisible,
    cancelContextualTour,
    emitContextualTourOutcome,
    onboardingVisible
  ])

  useEffect(() => {
    if (!activeTourId) {
      return
    }
    const scheduleMeasure = (): void => setMeasureVersion((version) => version + 1)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    const interval = window.setInterval(scheduleMeasure, 500)
    return () => {
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
      window.clearInterval(interval)
    }
  }, [activeTourId])

  useLayoutEffect(() => {
    if (!activeTour || activeTourId === null) {
      setRenderState(null)
      return
    }

    telemetryDefinedStepCountRef.current = activeTour.steps.length
    const measurement = measureContextualTourOverlayRenderState({
      tour: activeTour,
      activeStepIndex,
      sidebarOpen,
      keybindings,
      previousTelemetryTotalSteps: telemetryTotalStepsRef.current
    })
    telemetryTotalStepsRef.current = Math.max(
      telemetryTotalStepsRef.current,
      measurement.kind === 'render' ? measurement.telemetryTotalSteps : 0
    )

    if (measurement.kind === 'advance') {
      advanceContextualTour()
      return
    }
    if (measurement.kind === 'wait') {
      return
    }
    if (measurement.kind === 'cancel') {
      emitContextualTourOutcome('cancelled')
      cancelContextualTour(activeTourId)
      return
    }

    setRenderState(measurement.renderState)
  }, [
    activeStepIndex,
    activeTour,
    activeTourId,
    advanceContextualTour,
    cancelContextualTour,
    emitContextualTourOutcome,
    keybindings,
    measureVersion,
    sidebarOpen
  ])

  useEffect(() => {
    if (!activeTourId || !renderState || markedTourIdRef.current === activeTourId) {
      return
    }
    // Why: a tour is considered seen only after its first measured target
    // paints, so missing or removed surfaces can retry on a later visit.
    markedTourIdRef.current = activeTourId
    markContextualToursSeen([activeTourId])
  }, [activeTourId, markContextualToursSeen, renderState])

  useEffect(() => {
    if (!activeTourId || !renderState || telemetryTourIdRef.current === activeTourId) {
      return
    }
    telemetryTourIdRef.current = activeTourId
    telemetryStepsSeenRef.current.add(activeStepIndex)
    telemetryFurthestStepIndexRef.current = Math.max(
      telemetryFurthestStepIndexRef.current,
      activeStepIndex + 1
    )
    trackContextualTourShown({
      tourId: activeTourId,
      source: activeTourSource,
      wasFeaturePreviouslyInteracted
    })
  }, [activeStepIndex, activeTourId, activeTourSource, renderState, wasFeaturePreviouslyInteracted])

  useEffect(() => {
    if (!activeTourId || !renderState) {
      return
    }
    telemetryStepsSeenRef.current.add(activeStepIndex)
    telemetryFurthestStepIndexRef.current = Math.max(
      telemetryFurthestStepIndexRef.current,
      activeStepIndex + 1
    )
  }, [activeStepIndex, activeTourId, renderState])

  useEffect(() => {
    if (!activeTourId) {
      return
    }

    const emitPendingCancellation = (): void => {
      emitContextualTourOutcome(getContextualTourCleanupOutcome(activeTourId))
    }

    window.addEventListener('beforeunload', emitPendingCancellation)
    return () => {
      window.removeEventListener('beforeunload', emitPendingCancellation)
      // Why: analytics expects every shown tour to have an outcome, even when
      // the renderer closes or unmounts before the user presses Skip/Done.
      emitPendingCancellation()
    }
  }, [activeTourId, emitContextualTourOutcome])

  useEffect(() => {
    if (!activeTourId || !renderState) {
      return
    }
    const focusKey = `${activeTourId}:${activeStepIndex}`
    if (focusedStepRef.current === focusKey) {
      return
    }
    focusedStepRef.current = focusKey

    const currentFocus = document.activeElement
    if (
      !previousFocusRef.current &&
      currentFocus instanceof HTMLElement &&
      !panelRef.current?.contains(currentFocus)
    ) {
      previousFocusRef.current = currentFocus
    }

    const timeout = window.setTimeout(() => {
      const panel = panelRef.current
      const firstFocusable = panel ? getContextualTourFocusableElements(panel)[0] : null
      ;(firstFocusable ?? panel)?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [activeStepIndex, activeTourId, renderState])

  useEffect(() => {
    if (activeTourId) {
      return
    }
    focusedStepRef.current = null
    const previousFocus = previousFocusRef.current
    previousFocusRef.current = null
    if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true })
    }
  }, [activeTourId])

  if (!activeTourId || !renderState) {
    return null
  }

  const finishTour = (): void => {
    emitContextualTourOutcome('completed')
    completeContextualTour(activeTourId)
  }

  const handleStepAction = (action: ContextualTourStepAction): void => {
    performContextualTourStepAction({
      action,
      activeTabId,
      isLastStep: renderState.isLastStep,
      finishTour,
      advanceContextualTour,
      detachContextualTourSource: () => {
        if (activeTourSource) {
          detachContextualTourSource(activeTourId, activeTourSource)
        }
      },
      setSidebarOpen,
      openTaskPage,
      openModal,
      canCreateWorkspace,
      openWorkspaceComposer: openWorkspaceCreationComposerWithTourHandoff,
      dispatchTerminalPaneSplit: (detail) => {
        window.dispatchEvent(
          new CustomEvent<RequestActiveTerminalPaneSplitDetail>(
            REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
            { detail }
          )
        )
      },
      schedule: (callback) => {
        window.setTimeout(callback, 0)
      }
    })
  }

  const viewport = {
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight
  }
  const { panelPosition, panelPlacement } = getContextualTourOverlayPanelPosition({
    targetRect: renderState.rect,
    panelElement: panelRef.current,
    panelHost: renderState.panelHost,
    preferredPlacement: renderState.preferredPlacement,
    viewport
  })

  return (
    <ContextualTourOverlaySurface
      activeTourId={activeTourId}
      renderState={renderState}
      panelRef={panelRef}
      panelPosition={panelPosition}
      panelPlacement={panelPlacement}
      panelHost={renderState.panelHost}
      onSkip={(id) => {
        emitContextualTourOutcome('skipped')
        dismissContextualTour(id)
      }}
      onBack={regressContextualTour}
      onNext={() => {
        if (renderState.isLastStep) {
          finishTour()
        } else {
          advanceContextualTour()
        }
      }}
      onStepAction={handleStepAction}
      onOverlayKeyDownCapture={handleContextualTourOverlayKeyDown}
    />
  )
}

export { getContextualTourCleanupOutcome } from './contextual-tour-overlay-measurement'
