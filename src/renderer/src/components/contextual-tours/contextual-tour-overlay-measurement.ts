import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import type { ContextualTour, ContextualTourId } from '../../../../shared/contextual-tours'
import type { ContextualTourOutcome } from '../../../../shared/feature-education-telemetry'
import { useAppStore } from '@/store'
import {
  getContextualTourOutcomeStepTotal,
  getContextualTourPanelHost,
  getContextualTourStepCopy,
  getContextualTourStepProgress,
  getMeasurableContextualTourTarget,
  getVisibleContextualTourStepIndexes
} from './contextual-tour-gate'
import type { ActiveTourRenderState } from './ContextualTourOverlaySurface'
import { translate } from '@/i18n/i18n'

export type ContextualTourMeasurementAction =
  | { kind: 'wait' }
  | { kind: 'advance' }
  | { kind: 'cancel' }

export type ContextualTourOverlayMeasurementResult =
  | { kind: 'wait' }
  | { kind: 'advance' }
  | { kind: 'cancel' }
  | {
      kind: 'render'
      renderState: ActiveTourRenderState
      telemetryTotalSteps: number
    }

export function getContextualTourDisplayProgress(args: {
  tour: ContextualTour
  visibleStepIndexes: readonly number[]
  stepIndex: number
  activeStep: ContextualTour['steps'][number] | undefined
}): { current: number; total: number } | null {
  if (!args.activeStep) {
    return null
  }
  if (args.tour.id === 'browser') {
    return { current: args.stepIndex + 1, total: args.tour.steps.length }
  }
  return getContextualTourStepProgress({
    visibleStepIndexes: args.visibleStepIndexes,
    stepIndex: args.stepIndex
  })
}

export function getContextualTourMeasurementAction(args: {
  tour: ContextualTour
  visibleStepIndexes: readonly number[]
  activeStepIndex: number
}): ContextualTourMeasurementAction {
  if (args.visibleStepIndexes.some((index) => index > args.activeStepIndex)) {
    return { kind: 'advance' }
  }
  // Why: browser step 3's Import Cookies row appears only after that step is
  // active and the toolbar menu opens; keep remeasuring instead of cancelling.
  if (args.activeStepIndex < args.tour.steps.length - 1 || args.tour.id === 'browser') {
    return { kind: 'wait' }
  }
  return { kind: 'cancel' }
}

export function isContextualTourLastDisplayStep(args: {
  tour: ContextualTour
  activeStepIndex: number
  progress: { current: number; total: number }
}): boolean {
  if (args.tour.id === 'browser') {
    return args.activeStepIndex === args.tour.steps.length - 1
  }
  return args.progress.current === args.progress.total
}

export function measureContextualTourOverlayRenderState(args: {
  tour: ContextualTour
  activeStepIndex: number
  sidebarOpen: boolean
  keybindings: Parameters<typeof formatShortcutLabel>[1]
  previousTelemetryTotalSteps: number
}): ContextualTourOverlayMeasurementResult {
  const targetExists = (selector: string): boolean =>
    getMeasurableContextualTourTarget(selector) !== null
  const visibleStepIndexes = getVisibleContextualTourStepIndexes(args.tour, targetExists)
  const telemetryTotalSteps = Math.max(
    args.previousTelemetryTotalSteps,
    getContextualTourOutcomeStepTotal(visibleStepIndexes)
  )
  const activeStep = args.tour.steps[args.activeStepIndex]
  const target = activeStep ? getMeasurableContextualTourTarget(activeStep.targetSelector) : null
  const progress = getContextualTourDisplayProgress({
    tour: args.tour,
    visibleStepIndexes,
    stepIndex: args.activeStepIndex,
    activeStep
  })

  if (visibleStepIndexes.length === 0 || !activeStep || !progress) {
    return { kind: 'cancel' }
  }

  if (!target) {
    const measurementAction = getContextualTourMeasurementAction({
      tour: args.tour,
      visibleStepIndexes,
      activeStepIndex: args.activeStepIndex
    })
    if (measurementAction.kind === 'advance') {
      return { kind: 'advance' }
    }
    if (measurementAction.kind === 'wait') {
      return { kind: 'wait' }
    }
    return { kind: 'cancel' }
  }

  const sidebarAlreadyVisible =
    activeStep.primaryAction?.kind === 'show-worktrees' && args.sidebarOpen
  const primaryAction = sidebarAlreadyVisible
    ? ({ kind: 'next', label: translate("auto.components.contextual.tours.contextual.tour.overlay.measurement.38b3155418", "Next") } as const)
    : activeStep.primaryAction
  const secondaryAction = sidebarAlreadyVisible ? undefined : activeStep.secondaryAction

  return {
    kind: 'render',
    telemetryTotalSteps,
    renderState: {
      rect: target.rect,
      targetElement: target.element,
      progress,
      title: activeStep.title,
      body: formatContextualTourStepCopy(getContextualTourStepCopy(activeStep), args.keybindings),
      control: activeStep.control,
      primaryAction,
      secondaryAction,
      preferredPlacement: activeStep.preferredPlacement,
      targetPulse: activeStep.targetPulse,
      hidePrimaryAction: activeStep.hidePrimaryAction,
      isLastStep: isContextualTourLastDisplayStep({
        tour: args.tour,
        activeStepIndex: args.activeStepIndex,
        progress
      }),
      isFirstStep: progress.current === 1,
      panelHost: getContextualTourPanelHost(target.element)
    }
  }
}

export function getContextualTourCleanupOutcome(
  activeTourId: ContextualTourId
): ContextualTourOutcome {
  return useAppStore.getState().lastCompletedContextualTourId === activeTourId
    ? 'completed'
    : 'cancelled'
}

function formatContextualTourStepCopy(
  copy: string,
  keybindings: Parameters<typeof formatShortcutLabel>[1]
): string {
  return copy.replace(
    '{terminal.splitRight}',
    formatShortcutLabel('terminal.splitRight', keybindings)
  )
}
