import { formatOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type {
  ContextualTour,
  ContextualTourId,
  ContextualTourStep,
  ContextualTourStepAction
} from '../../../../shared/contextual-tours'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { ContextualTourOutcome } from '../../../../shared/feature-education-telemetry'
import { useAppStore } from '@/store'
import {
  getContextualTourDisplayProgress,
  getContextualTourOutcomeStepTotal,
  getContextualTourPanelHost,
  getContextualTourStepCopy,
  getMeasurableContextualTourTarget,
  getVisibleContextualTourStepIndexes
} from './contextual-tour-gate'
import type { ActiveTourRenderState } from './ContextualTourOverlaySurface'
import { getLocalizedContextualTourStepCopy } from './contextual-tour-step-copy'
import { translate } from '@/i18n/i18n'

export type ContextualTourMeasurementAction =
  | { kind: 'wait' }
  | { kind: 'advance' }
  | { kind: 'regress' }
  | { kind: 'cancel' }

export type ContextualTourOverlayMeasurementResult =
  | { kind: 'wait' }
  | { kind: 'advance' }
  | { kind: 'regress' }
  | { kind: 'cancel' }
  | {
      kind: 'render'
      renderState: ActiveTourRenderState
      telemetryTotalSteps: number
    }

export { getContextualTourDisplayProgress } from './contextual-tour-gate'

export function getContextualTourMeasurementAction(args: {
  tour: ContextualTour
  visibleStepIndexes: readonly number[]
  activeStepIndex: number
  activeTabType?: WorkspaceVisibleTabType
  isStepDone?: (step: ContextualTourStep) => boolean
}): ContextualTourMeasurementAction {
  const activeStep = args.tour.steps[args.activeStepIndex]
  const activeKind = activeStep?.primaryAction?.kind
  if (
    args.tour.id === 'workspace-agent-sessions' &&
    (activeKind === 'split-chat-pane' || activeKind === 'split-terminal-pane')
  ) {
    const alternateKind =
      activeKind === 'split-chat-pane' ? 'split-terminal-pane' : 'split-chat-pane'
    const alternateIndex = args.visibleStepIndexes.find(
      (index) => args.tour.steps[index]?.primaryAction?.kind === alternateKind
    )
    if (alternateIndex !== undefined) {
      if (args.isStepDone?.(args.tour.steps[alternateIndex])) {
        return { kind: 'advance' }
      }
      return { kind: alternateIndex < args.activeStepIndex ? 'regress' : 'advance' }
    }
    // A just-opened terminal or chat pane mounts after the tab switch; don't skip its split lesson.
    const activeTabType = args.activeTabType
    if (activeTabType === 'terminal' || activeTabType === 'agent-session') {
      return { kind: 'wait' }
    }
  }
  if (
    args.tour.id === 'workspace-agent-sessions' &&
    activeStep?.advanceOnFeatureInteraction &&
    !args.isStepDone?.(activeStep)
  ) {
    return { kind: 'wait' }
  }
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
  keybindings: Parameters<typeof formatOptionalShortcutLabel>[1]
  previousTelemetryTotalSteps: number
  activeTabType?: WorkspaceVisibleTabType
  isStepDone?: (step: ContextualTourStep) => boolean
}): ContextualTourOverlayMeasurementResult {
  const targetExists = (selector: string): boolean =>
    getMeasurableContextualTourTarget(selector) !== null
  const visibleStepIndexes = getVisibleContextualTourStepIndexes(
    args.tour,
    targetExists,
    args.activeTabType
  )
  const telemetryTotalSteps = Math.max(
    args.previousTelemetryTotalSteps,
    getContextualTourOutcomeStepTotal(visibleStepIndexes)
  )
  const activeStep = args.tour.steps[args.activeStepIndex]
  const target =
    activeStep && visibleStepIndexes.includes(args.activeStepIndex)
      ? getMeasurableContextualTourTarget(activeStep.targetSelector)
      : null
  const progress = getContextualTourDisplayProgress({
    tour: args.tour,
    visibleStepIndexes,
    stepIndex: args.activeStepIndex,
    activeStep
  })

  if (
    visibleStepIndexes.length === 0 &&
    activeStep?.advanceOnFeatureInteraction &&
    !args.isStepDone?.(activeStep)
  ) {
    return { kind: 'wait' }
  }
  if (visibleStepIndexes.length === 0 || !activeStep) {
    return { kind: 'cancel' }
  }

  if (!target) {
    const actionKind = activeStep.primaryAction?.kind
    const canSwitchSplitLesson =
      args.tour.id === 'workspace-agent-sessions' &&
      (actionKind === 'split-chat-pane' || actionKind === 'split-terminal-pane')
    if (!progress && !canSwitchSplitLesson && !activeStep.advanceOnFeatureInteraction) {
      return { kind: 'cancel' }
    }
    const measurementAction = getContextualTourMeasurementAction({
      tour: args.tour,
      visibleStepIndexes,
      activeStepIndex: args.activeStepIndex,
      activeTabType: args.activeTabType,
      isStepDone: args.isStepDone
    })
    return measurementAction
  }

  if (!progress) {
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
      badge: activeStep.badge,
      body: formatContextualTourStepCopy(
        localizedCopy?.body ?? getContextualTourStepCopy(activeStep),
        args.keybindings,
        localizedCopy?.bodyWithoutShortcut
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

const STEP_COPY_SHORTCUT_ACTIONS = [
  'terminal.splitRight',
  'sidebar.projects.toggleCollapse'
] as const satisfies readonly Parameters<typeof formatOptionalShortcutLabel>[0][]

function formatContextualTourStepCopy(
  copy: string,
  keybindings: Parameters<typeof formatOptionalShortcutLabel>[1],
  copyWithoutShortcut?: string
): string {
  let formatted = copy
  for (const actionId of STEP_COPY_SHORTCUT_ACTIONS) {
    const token = `{${actionId}}`
    if (!formatted.includes(token)) {
      continue
    }
    const shortcut = formatOptionalShortcutLabel(actionId, keybindings)
    // An unbound shortcut would leave "Press , or …"; name only the click path instead.
    if (!shortcut && copyWithoutShortcut) {
      return copyWithoutShortcut
    }
    formatted = formatted.replace(token, shortcut ?? '')
  }
  return formatted
}
