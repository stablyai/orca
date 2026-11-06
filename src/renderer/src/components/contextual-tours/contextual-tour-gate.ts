export {
  getMeasurableContextualTourTarget,
  hasContextualTourTarget
} from './contextual-tour-target'
export type { ContextualTourTarget } from './contextual-tour-target'
import type { ContextualTour, ContextualTourStep } from '../../../../shared/contextual-tours'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'

export type ContextualTourRequestDecision =
  | { kind: 'start'; stepIndex: number }
  | {
      kind: 'blocked'
      reason:
        | 'persisted-ui-not-ready'
        | 'auto-disabled'
        | 'onboarding'
        | 'seen'
        | 'already-progressed'
        | 'session-consumed'
        | 'active-tour'
        | 'modal'
        | 'blocking-surface'
        | 'missing-start-target'
    }

const PANEL_HOST_SELECTOR = '[data-slot="dialog-content"], [data-slot="sheet-content"]'

export function getContextualTourPanelHost(targetElement: Element): HTMLElement | null {
  return targetElement.closest<HTMLElement>(PANEL_HOST_SELECTOR)
}

export function isContextualTourAllowedForModal(
  tour: ContextualTour,
  activeModal: string
): boolean {
  if (activeModal === 'none') {
    return true
  }
  return tour.allowedActiveModals?.includes(activeModal) === true
}

export function getContextualTourStartStepIndex(
  tour: ContextualTour,
  targetExists: (selector: string) => boolean,
  isStepDone: (step: ContextualTourStep) => boolean = () => false,
  activeTabType?: WorkspaceVisibleTabType
): number | null {
  const completedSplitIndex = tour.steps.findIndex(
    (step) =>
      isContextualTourStepApplicable(step, activeTabType) &&
      (step.primaryAction?.kind === 'split-chat-pane' ||
        step.primaryAction?.kind === 'split-terminal-pane') &&
      isStepDone(step)
  )
  if (
    tour.id === 'workspace-agent-sessions' &&
    (activeTabType === 'terminal' || activeTabType === 'agent-session') &&
    completedSplitIndex !== -1
  ) {
    const nextIndex = getNextVisibleContextualTourStepIndex({
      tour,
      currentStepIndex: completedSplitIndex,
      targetExists,
      isStepDone,
      activeTabType
    })
    return nextIndex !== null && targetExists(tour.steps[nextIndex].targetSelector)
      ? nextIndex
      : null
  }
  const requiredStepIndexes = tour.steps.flatMap((step, index) =>
    step.requiredForStart === true && isContextualTourStepApplicable(step, activeTabType)
      ? [index]
      : []
  )
  const candidates = requiredStepIndexes.length > 0 ? requiredStepIndexes : [0]
  // This tour resumes only from its matching split, resolved above; later actions do not fulfill it.
  const lastDoneIndex =
    tour.id === 'workspace-agent-sessions'
      ? -1
      : tour.steps.findLastIndex((step) => isStepDone(step))
  for (const candidate of candidates) {
    let startIndex = Math.max(candidate, lastDoneIndex)
    while (startIndex < tour.steps.length - 1 && isStepDone(tour.steps[startIndex])) {
      const nextIndex = getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: startIndex,
        targetExists,
        isStepDone,
        activeTabType
      })
      if (nextIndex === null) {
        return null
      }
      startIndex = nextIndex
    }
    const step = tour.steps[startIndex]
    if (step && targetExists(step.targetSelector)) {
      return startIndex
    }
  }
  return null
}

export function getVisibleContextualTourStepIndexes(
  tour: ContextualTour,
  targetExists: (selector: string) => boolean,
  activeTabType?: WorkspaceVisibleTabType
): number[] {
  const indexes: number[] = []
  tour.steps.forEach((step, index) => {
    if (isContextualTourStepApplicable(step, activeTabType) && targetExists(step.targetSelector)) {
      indexes.push(index)
    }
  })
  return indexes
}

function isContextualTourStepApplicable(
  step: ContextualTourStep,
  activeTabType: WorkspaceVisibleTabType | undefined
): boolean {
  if (activeTabType === undefined) {
    return true
  }
  if (step.primaryAction?.kind === 'split-chat-pane') {
    return activeTabType === 'agent-session'
  }
  if (step.primaryAction?.kind === 'split-terminal-pane') {
    return activeTabType === 'terminal'
  }
  return true
}

export function getNextVisibleContextualTourStepIndex(args: {
  tour: ContextualTour
  currentStepIndex: number
  targetExists: (selector: string) => boolean
  isStepDone?: (step: ContextualTourStep) => boolean
  activeTabType?: WorkspaceVisibleTabType
}): number | null {
  const index = args.tour.steps.findIndex(
    (step, index) =>
      index > args.currentStepIndex &&
      isContextualTourStepApplicable(step, args.activeTabType) &&
      !args.isStepDone?.(step) &&
      (args.targetExists(step.targetSelector) ||
        (args.tour.id === 'workspace-agent-sessions' &&
          step.advanceOnFeatureInteraction !== undefined))
  )
  return index === -1 ? null : index
}

export function getPreviousVisibleContextualTourStepIndex(args: {
  tour: ContextualTour
  currentStepIndex: number
  targetExists: (selector: string) => boolean
  activeTabType?: WorkspaceVisibleTabType
}): number | null {
  const visible = getVisibleContextualTourStepIndexes(
    args.tour,
    args.targetExists,
    args.activeTabType
  )
  let prev: number | null = null
  for (const index of visible) {
    if (index >= args.currentStepIndex) {
      break
    }
    prev = index
  }
  return prev
}

export function getContextualTourRequestDecision(args: {
  tour: ContextualTour
  persistedUIReady: boolean
  autoEligible: boolean
  onboardingVisible: boolean
  seenIds: readonly string[]
  progressBlocked: boolean
  sessionConsumed: boolean
  activeTourId: string | null
  activeModal: string
  blockingSurfaceVisible: boolean
  targetExists: (selector: string) => boolean
  isStepDone?: (step: ContextualTourStep) => boolean
  activeTabType?: WorkspaceVisibleTabType
}): ContextualTourRequestDecision {
  if (!args.persistedUIReady) {
    return { kind: 'blocked', reason: 'persisted-ui-not-ready' }
  }
  if (!args.autoEligible) {
    return { kind: 'blocked', reason: 'auto-disabled' }
  }
  if (args.onboardingVisible) {
    return { kind: 'blocked', reason: 'onboarding' }
  }
  if (args.seenIds.includes(args.tour.id)) {
    return { kind: 'blocked', reason: 'seen' }
  }
  if (args.progressBlocked) {
    return { kind: 'blocked', reason: 'already-progressed' }
  }
  if (args.sessionConsumed) {
    return { kind: 'blocked', reason: 'session-consumed' }
  }
  if (args.activeTourId !== null) {
    return { kind: 'blocked', reason: 'active-tour' }
  }
  if (!isContextualTourAllowedForModal(args.tour, args.activeModal)) {
    return { kind: 'blocked', reason: 'modal' }
  }
  if (args.blockingSurfaceVisible) {
    return { kind: 'blocked', reason: 'blocking-surface' }
  }

  const stepIndex = getContextualTourStartStepIndex(
    args.tour,
    args.targetExists,
    args.isStepDone,
    args.activeTabType
  )
  if (stepIndex === null) {
    return { kind: 'blocked', reason: 'missing-start-target' }
  }
  return { kind: 'start', stepIndex }
}

export function getContextualTourStepProgress(args: {
  visibleStepIndexes: readonly number[]
  stepIndex: number
}): { current: number; total: number } | null {
  const visibleIndex = args.visibleStepIndexes.indexOf(args.stepIndex)
  if (visibleIndex === -1) {
    return null
  }
  return { current: visibleIndex + 1, total: args.visibleStepIndexes.length }
}

export function getContextualTourOutcomeStepTotal(
  visibleStepIndexes: readonly number[],
  fallback = 1
): number {
  return visibleStepIndexes.length > 0 ? visibleStepIndexes.length : fallback
}

export function getContextualTourStepCopy(step: ContextualTourStep): string {
  return step.body || step.fallbackCopy || ''
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
