import type { ContextualTour, ContextualTourStep } from '../../../../shared/contextual-tours'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'

export type ContextualTourTarget = {
  element: Element
  rect: DOMRect
}

export type ContextualTourRequestDecision =
  | { kind: 'start'; stepIndex: number }
  | {
      kind: 'blocked'
      reason:
        | 'persisted-ui-not-ready'
        | 'auto-disabled'
        | 'onboarding'
        | 'seen'
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

export function getMeasurableContextualTourTarget(
  selector: string,
  root?: ParentNode
): ContextualTourTarget | null {
  const queryRoot = root ?? (typeof document !== 'undefined' ? document : null)
  const elements = getContextualTourTargetCandidates(selector, queryRoot)
  for (const element of elements) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      continue
    }
    if (!isContextualTourTargetVisible(element)) {
      continue
    }
    let rect: DOMRect
    try {
      rect = element.getBoundingClientRect()
    } catch {
      continue
    }
    if (isMeasurableRect(rect)) {
      return { element, rect }
    }
  }
  return null
}

export function hasContextualTourTarget(selector: string, root?: ParentNode): boolean {
  return getMeasurableContextualTourTarget(selector, root) !== null
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
  for (const candidate of candidates) {
    let startIndex = candidate
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

function isMeasurableRect(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0
  )
}

function getContextualTourTargetCandidates(
  selector: string,
  queryRoot: ParentNode | null
): Element[] {
  if (!queryRoot) {
    return []
  }
  try {
    if (typeof queryRoot.querySelectorAll === 'function') {
      return Array.from(queryRoot.querySelectorAll(selector))
    }
    return queryRoot.querySelector(selector) ? [queryRoot.querySelector(selector)!] : []
  } catch {
    return []
  }
}

function isContextualTourTargetVisible(element: Element): boolean {
  if (
    typeof element.closest === 'function' &&
    element.closest('[hidden],[inert],[aria-hidden="true"]')
  ) {
    return false
  }

  if (typeof window === 'undefined' || typeof HTMLElement === 'undefined') {
    return true
  }

  let current: Element | null = element
  while (current instanceof HTMLElement) {
    const style = window.getComputedStyle(current)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false
    }
    current = current.parentElement
  }
  return true
}
