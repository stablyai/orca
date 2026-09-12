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

// Why: keyed by the step's stable id, not its position — inserting a step must
// not shift localized copy onto a neighbour. Thunks keep translate() out of
// module scope so the lookup resolves in the language active at render time.
const LOCALIZED_STEP_COPY: Record<string, { title: () => string; body: () => string }> = {
  'automations-intro': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.intro.title',
        'What is an automation?'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.intro.body',
        'Automations run agent work on a schedule. Add an automation by clicking this button.'
      )
  },
  'client-hosted-browser-intro': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.client.hosted.browser.intro.title',
        'This page renders on your desktop'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.client.hosted.browser.intro.body',
        'Remote browser tabs now render on this device. Network traffic still goes through the remote host.'
      )
  },
  'automations-results': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.results.title',
        'Find the results'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.results.body',
        'Runs show when automations ran, what happened, and where to inspect their output.'
      )
  }
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
  const localizedCopy = activeStep?.id ? LOCALIZED_STEP_COPY[activeStep.id] : undefined
  const localizedTitle = localizedCopy ? localizedCopy.title() : activeStep?.title
  const localizedBody = localizedCopy
    ? localizedCopy.body()
    : activeStep
      ? getContextualTourStepCopy(activeStep)
      : undefined
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
    ? ({
        kind: 'next',
        label: translate(
          'auto.components.contextual.tours.contextual.tour.overlay.measurement.38b3155418',
          'Next'
        )
      } as const)
    : activeStep.primaryAction
  const secondaryAction = sidebarAlreadyVisible ? undefined : activeStep.secondaryAction

  return {
    kind: 'render',
    telemetryTotalSteps,
    renderState: {
      rect: target.rect,
      targetElement: target.element,
      progress,
      title: localizedTitle ?? activeStep.title,
      body: formatContextualTourStepCopy(
        localizedBody ?? getContextualTourStepCopy(activeStep),
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

// Why: a scroll anywhere in the app reaches the overlay's capture-phase
// listener. One rect read decides whether the full step scan is worth running.
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

// Why: re-measures fire on scroll, resize and the liveness poll, but the
// measured state almost never changes. Bail out so an unchanged pass costs no
// React commit and no floating-position resubscribe.
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

function formatContextualTourStepCopy(
  copy: string,
  keybindings: Parameters<typeof formatShortcutLabel>[1]
): string {
  return copy.replace(
    '{terminal.splitRight}',
    formatShortcutLabel('terminal.splitRight', keybindings)
  )
}
