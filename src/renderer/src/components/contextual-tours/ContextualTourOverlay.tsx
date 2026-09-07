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
  areContextualTourRenderStatesEqual,
  getContextualTourCleanupOutcome,
  hasContextualTourTargetMoved,
  measureContextualTourOverlayRenderState,
  type MeasuredContextualTourTarget
} from './contextual-tour-overlay-measurement'
import {
  ContextualTourOverlaySurface,
  getContextualTourFocusableElements,
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split'
import { performContextualTourStepAction } from './contextual-tour-step-actions'
import { openWorkspaceCreationComposerWithTourHandoff } from './workspace-creation-tour-handoff'
import { BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'

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
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const [renderState, setRenderState] = useState<ActiveTourRenderState | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const measuredTargetRef = useRef<MeasuredContextualTourTarget | null>(null)
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

  const measureTourOverlay = useCallback((): void => {
    if (!activeTour || activeTourId === null) {
      measuredTargetRef.current = null
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

    if (measurement.kind !== 'render') {
      // Why: drop the old target so the next scroll runs a full pass instead of
      // probing an element the step no longer uses (and may have detached).
      measuredTargetRef.current = null
    }
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

    measuredTargetRef.current = {
      element: measurement.renderState.targetElement,
      rect: measurement.renderState.rect
    }
    setRenderState((previous) =>
      areContextualTourRenderStatesEqual(previous, measurement.renderState)
        ? previous
        : measurement.renderState
    )
  }, [
    activeStepIndex,
    activeTour,
    activeTourId,
    advanceContextualTour,
    cancelContextualTour,
    emitContextualTourOutcome,
    keybindings,
    sidebarOpen
  ])

  useEffect(() => {
    if (!activeTourId) {
      return
    }
    // Why: all three triggers land on one frame, and scroll — which the
    // capture-phase listener receives for every scrollable pane in the app —
    // pays one rect read unless the tour's own target actually moved. Step
    // targets appearing or vanishing are still caught by the 500ms pass.
    let frame: number | null = null
    let fullPassQueued = false
    const scheduleMeasure = (fullPass: boolean): void => {
      fullPassQueued = fullPassQueued || fullPass
      if (frame !== null) {
        return
      }
      frame = window.requestAnimationFrame(() => {
        frame = null
        const runFullPass = fullPassQueued
        fullPassQueued = false
        if (runFullPass || hasContextualTourTargetMoved(measuredTargetRef.current)) {
          measureTourOverlay()
        }
      })
    }
    const scheduleTargetMeasure = (): void => scheduleMeasure(false)
    const scheduleFullMeasure = (): void => scheduleMeasure(true)
    window.addEventListener('resize', scheduleFullMeasure)
    window.addEventListener('scroll', scheduleTargetMeasure, true)
    // Why gated: a hidden window paints no frames, so the queued rAF never runs
    // and the pass is pure wakeup. The becoming-visible run re-queues it, and
    // the layout effect measures on every render, so nothing is missed.
    const stopFullPassInterval = installWindowVisibilityInterval({
      run: scheduleFullMeasure,
      intervalMs: 500
    })
    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      window.removeEventListener('resize', scheduleFullMeasure)
      window.removeEventListener('scroll', scheduleTargetMeasure, true)
      stopFullPassInterval()
    }
  }, [activeTourId, measureTourOverlay])

  useLayoutEffect(() => {
    measureTourOverlay()
  }, [measureTourOverlay])

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
      openClientHostedBrowserSettings: () => {
        openSettingsTarget({
          pane: 'browser',
          repoId: null,
          sectionId: BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID
        })
        openSettingsPage()
      },
      openWorkspaceComposer: openWorkspaceCreationComposerWithTourHandoff,
      dispatchTerminalPaneSplit: requestActiveTerminalPaneSplit,
      schedule: (callback) => {
        window.setTimeout(callback, 0)
      }
    })
  }

  return (
    <ContextualTourOverlaySurface
      activeTourId={activeTourId}
      renderState={renderState}
      panelRef={panelRef}
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
