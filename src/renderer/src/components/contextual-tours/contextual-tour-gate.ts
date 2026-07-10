import type { ContextualTour, ContextualTourStep } from '../../../../shared/contextual-tours'

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
  if (!elements) {
    return null
  }
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
  targetExists: (selector: string) => boolean
): number | null {
  const requiredStepIndex = tour.steps.findIndex((step) => step.requiredForStart === true)
  const startIndex = Math.max(requiredStepIndex, 0)
  const step = tour.steps[startIndex]
  if (!step || !targetExists(step.targetSelector)) {
    return null
  }
  return startIndex
}

export function getVisibleContextualTourStepIndexes(
  tour: ContextualTour,
  targetExists: (selector: string) => boolean
): number[] {
  const indexes: number[] = []
  tour.steps.forEach((step, index) => {
    if (targetExists(step.targetSelector)) {
      indexes.push(index)
    }
  })
  return indexes
}

export function getNextVisibleContextualTourStepIndex(args: {
  tour: ContextualTour
  currentStepIndex: number
  targetExists: (selector: string) => boolean
}): number | null {
  return (
    getVisibleContextualTourStepIndexes(args.tour, args.targetExists).find(
      (index) => index > args.currentStepIndex
    ) ?? null
  )
}

export function getPreviousVisibleContextualTourStepIndex(args: {
  tour: ContextualTour
  currentStepIndex: number
  targetExists: (selector: string) => boolean
}): number | null {
  const visible = getVisibleContextualTourStepIndexes(args.tour, args.targetExists)
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

  const stepIndex = getContextualTourStartStepIndex(args.tour, args.targetExists)
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
  if (visibleIndex < 0) {
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
): Element[] | null {
  if (!queryRoot) {
    return []
  }
  try {
    if (typeof queryRoot.querySelectorAll === 'function') {
      return Array.from(queryRoot.querySelectorAll(selector))
    }
    return queryRoot.querySelector(selector) ? [queryRoot.querySelector(selector)!] : []
  } catch {
    return null
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
