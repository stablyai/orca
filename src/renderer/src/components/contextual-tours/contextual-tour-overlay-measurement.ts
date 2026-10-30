import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import type {
  ContextualTour,
  ContextualTourId,
  ContextualTourStepAction
} from '../../../../shared/contextual-tours'
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
import { getLocalizedContextualTourStepCopy } from './contextual-tour-step-copy'
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
  // Browser import appears only after activating its step and opening the menu; keep measuring instead of cancelling.
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

  const localizedCopy = getLocalizedContextualTourStepCopy(activeStep.id)
  const sidebarAlreadyVisible =
    activeStep.primaryAction?.kind === 'show-worktrees' && args.sidebarOpen
  const primaryAction = sidebarAlreadyVisible
    ? ({
        kind: 'next',
        label: translate(
          'auto.components.contextual.tours.contextual.tour.overlay.measurement.38b3155418',
          'Next'
        )
      } as const)
    : withLocalizedLabel(activeStep.primaryAction, localizedCopy?.primaryActionLabel)
  const secondaryAction = sidebarAlreadyVisible
    ? undefined
    : withLocalizedLabel(activeStep.secondaryAction, localizedCopy?.secondaryActionLabel)

  return {
    kind: 'render',
    telemetryTotalSteps,
    renderState: {
      rect: target.rect,
      targetElement: target.element,
      progress,
      title: localizedCopy?.title ?? activeStep.title,
      body: formatContextualTourStepCopy(
        localizedCopy?.body ?? getContextualTourStepCopy(activeStep),
        args.keybindings
      ),
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

export type MeasuredContextualTourTarget = { element: Element; rect: DOMRect }

// App-wide capture scroll needs only one rect probe before paying for a full step scan.
export function hasContextualTourTargetMoved(
  measured: MeasuredContextualTourTarget | null
): boolean {
  if (!measured) {
    return true
  }
  const rect = measured.element.getBoundingClientRect()
  return (
    rect.left !== measured.rect.left ||
    rect.top !== measured.rect.top ||
    rect.width !== measured.rect.width ||
    rect.height !== measured.rect.height
  )
}

// Skip unchanged measurements to avoid React commits and floating-position resubscription.
export function areContextualTourRenderStatesEqual(
  a: ActiveTourRenderState | null,
  b: ActiveTourRenderState | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return (
    a.targetElement === b.targetElement &&
    a.panelHost === b.panelHost &&
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height &&
    a.progress.current === b.progress.current &&
    a.progress.total === b.progress.total &&
    a.title === b.title &&
    a.body === b.body &&
    a.control === b.control &&
    a.preferredPlacement === b.preferredPlacement &&
    a.targetPulse === b.targetPulse &&
    a.hidePrimaryAction === b.hidePrimaryAction &&
    a.isLastStep === b.isLastStep &&
    a.isFirstStep === b.isFirstStep &&
    areStepActionsEqual(a.primaryAction, b.primaryAction) &&
    areStepActionsEqual(a.secondaryAction, b.secondaryAction)
  )
}

function areStepActionsEqual(
  a: ActiveTourRenderState['primaryAction'],
  b: ActiveTourRenderState['primaryAction']
): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return a.kind === b.kind && a.label === b.label
}

export function getContextualTourCleanupOutcome(
  activeTourId: ContextualTourId
): ContextualTourOutcome {
  return useAppStore.getState().lastCompletedContextualTourId === activeTourId
    ? 'completed'
    : 'cancelled'
}

function withLocalizedLabel(
  action: ContextualTourStepAction | undefined,
  label: string | undefined
): ContextualTourStepAction | undefined {
  return action && label ? { ...action, label } : action
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
