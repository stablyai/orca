import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '@/store'
import { runActiveNativeChatSplit } from '@/components/native-chat/native-chat-layout-actions'
import {
  getContextualTour,
  hasUndoneContextualTourAction,
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
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split'
import { performContextualTourStepAction } from './contextual-tour-step-actions'
import { useContextualTourFocus } from './use-contextual-tour-focus'
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
  const activeTourHasUndoneAction = useAppStore((s) =>
    s.activeContextualTourId
      ? hasUndoneContextualTourAction(
          getContextualTour(s.activeContextualTourId),
          s.featureInteractions,
          s.activeContextualTourStepIndex
        )
      : false
  )
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTabType = useAppStore((s) => s.activeTabType)
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
  const renderedStepIndexRef = useRef<number | null>(null)
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
    // Reset before layout measurement; a later passive reset could hide the freshly measured tour.
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
      // Discard stale/detached targets so the next scroll performs a full scan.
      measuredTargetRef.current = null
      setRenderState(null)
    }
    if (measurement.kind === 'advance') {
      advanceContextualTour()
      return
    }
    if (measurement.kind === 'regress') {
      regressContextualTour()
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
    renderedStepIndexRef.current = activeStepIndex
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
    regressContextualTour,
    sidebarOpen
  ])

  useEffect(() => {
    if (!activeTourId) {
      return
    }
    // Coalesce triggers per frame; scroll probes only the target rect, while 500ms scans detect appearing/disappearing steps.
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
    // Hidden windows cannot run queued rAF; resume full measurement when visible instead of polling idle.
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
  }, [activeTabId, activeTabType, measureTourOverlay])

  useEffect(() => {
    if (
      !activeTourId ||
      !renderState ||
      activeTourHasUndoneAction ||
      // A step change keeps the previous step's renderState until the new step measures.
      renderedStepIndexRef.current !== activeStepIndex ||
      markedTourIdRef.current === activeTourId
    ) {
      return
    }
    // Mark seen only after the first measured target paints so missing surfaces may retry; a step
    // waiting for its action stays pending through interruptions until it succeeds or is dismissed.
    markedTourIdRef.current = activeTourId
    markContextualToursSeen([activeTourId])
  }, [
    activeStepIndex,
    activeTourHasUndoneAction,
    activeTourId,
    markContextualToursSeen,
    renderState
  ])

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
      // Record an outcome for shown tours even if the renderer exits before Skip/Done.
      emitPendingCancellation()
    }
  }, [activeTourId, emitContextualTourOutcome])

  useContextualTourFocus({
    activeTourId,
    activeStepIndex,
    rendered: renderState !== null,
    panelRef
  })

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
      splitActiveChat: () => {
        const { activeWorktreeId, activeGroupIdByWorktree } = useAppStore.getState()
        runActiveNativeChatSplit(
          activeWorktreeId,
          activeWorktreeId ? (activeGroupIdByWorktree[activeWorktreeId] ?? null) : null,
          'right'
        )
      },
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
