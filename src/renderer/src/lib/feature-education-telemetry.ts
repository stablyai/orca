import type { ContextualTourId } from '../../../shared/contextual-tours'
import type { EventName, EventProps } from '../../../shared/telemetry-events'
import {
  normalizeFeatureEducationSource,
  normalizeSetupGuideSource,
  type ContextualTourOutcome,
  type SetupGuideCloseOutcome,
  type SetupGuideSource,
  type TerminalPaneSplitSource
} from '../../../shared/feature-education-telemetry'
import {
  isFeatureWallSetupStepId,
  type FeatureWallSetupStepId
} from '../../../shared/feature-wall-setup-steps'
import { track } from './telemetry'

const SETUP_GUIDE_TELEMETRY_COMPLETED_STEPS_STORAGE_KEY =
  'orca.setupGuideTelemetryCompletedSteps.v1'
const TERMINAL_PANE_SPLIT_TELEMETRY_STORAGE_KEY = 'orca.terminalPaneSplitTelemetry.v1'
const SETUP_GUIDE_PARALLEL_WORK_STEP_IDS = new Set<FeatureWallSetupStepId>([
  'split-terminal',
  'two-worktrees'
])

type FeatureEducationTelemetryEventName = Extract<
  EventName,
  | 'contextual_tour_shown'
  | 'contextual_tour_outcome'
  | 'setup_guide_opened'
  | 'setup_guide_closed'
  | 'setup_guide_step_completed'
  | 'terminal_pane_split'
>

export function trackContextualTourShown(args: {
  tourId: ContextualTourId
  source: string | null | undefined
  wasFeaturePreviouslyInteracted: boolean
}): void {
  emitFeatureEducationTelemetry('contextual_tour_shown', {
    tour_id: args.tourId,
    source: normalizeFeatureEducationSource(args.source),
    was_feature_previously_interacted: args.wasFeaturePreviouslyInteracted
  })
}

export function trackContextualTourOutcome(args: {
  tourId: ContextualTourId
  source: string | null | undefined
  outcome: ContextualTourOutcome
  stepsSeen: number
  totalSteps: number
  furthestStepIndex?: number
  definedStepCount?: number
}): void {
  emitFeatureEducationTelemetry('contextual_tour_outcome', {
    tour_id: args.tourId,
    source: normalizeFeatureEducationSource(args.source),
    outcome: args.outcome,
    steps_seen: clampTourStepCount(args.stepsSeen),
    total_steps: clampTourStepCount(args.totalSteps, 1),
    ...(args.furthestStepIndex !== undefined && args.definedStepCount !== undefined
      ? {
          furthest_step_index: clampTourStepCount(args.furthestStepIndex, 1),
          defined_step_count: clampTourStepCount(args.definedStepCount, 1)
        }
      : {})
  })
}

export function trackSetupGuideOpened(args: {
  source: string | null | undefined
  initialCompletedCount: number
  totalSteps: number
  firstIncompleteStepId: FeatureWallSetupStepId | 'none'
}): SetupGuideSource {
  const source = normalizeSetupGuideSource(args.source)
  emitFeatureEducationTelemetry('setup_guide_opened', {
    source,
    initial_completed_count: clampSetupGuideStepCount(args.initialCompletedCount),
    total_steps: 8,
    first_incomplete_step_id: args.firstIncompleteStepId
  })
  return source
}

export function trackSetupGuideClosed(args: {
  source: SetupGuideSource
  outcome: SetupGuideCloseOutcome
  initialCompletedCount: number
  finalCompletedCount: number
  totalSteps: number
  activeStepId: FeatureWallSetupStepId | 'none'
}): void {
  const initialCompletedCount = clampSetupGuideStepCount(args.initialCompletedCount)
  const finalCompletedCount = Math.max(
    initialCompletedCount,
    clampSetupGuideStepCount(args.finalCompletedCount)
  )
  emitFeatureEducationTelemetry('setup_guide_closed', {
    source: args.source,
    outcome: args.outcome,
    initial_completed_count: initialCompletedCount,
    final_completed_count: finalCompletedCount,
    total_steps: 8,
    active_step_id: args.activeStepId
  })
}

export function trackSetupGuideStepCompleted(args: {
  stepId: FeatureWallSetupStepId
  completedCount: number
  totalSteps: number
  setupGuideVisible: boolean
}): void {
  emitFeatureEducationTelemetry('setup_guide_step_completed', {
    step_id: args.stepId,
    section_id: getSetupGuideStepSection(args.stepId),
    completed_count: clampSetupGuideStepCount(args.completedCount, 1),
    total_steps: 8,
    setup_guide_visible: args.setupGuideVisible
  })
}

export function trackTerminalPaneSplit(args: {
  source: TerminalPaneSplitSource
  direction: 'vertical' | 'horizontal'
}): void {
  if (!reserveTerminalPaneSplitTelemetry(args.source, args.direction)) {
    return
  }
  emitFeatureEducationTelemetry('terminal_pane_split', {
    source: args.source,
    direction: args.direction
  })
}

export function readEmittedSetupGuideStepIds(): Set<FeatureWallSetupStepId> {
  if (typeof globalThis.localStorage === 'undefined') {
    return new Set()
  }
  try {
    const raw = JSON.parse(
      globalThis.localStorage.getItem(SETUP_GUIDE_TELEMETRY_COMPLETED_STEPS_STORAGE_KEY) ?? '[]'
    )
    if (!Array.isArray(raw)) {
      return new Set()
    }
    return new Set(raw.filter(isFeatureWallSetupStepId))
  } catch {
    return new Set()
  }
}

export function persistEmittedSetupGuideStepId(id: FeatureWallSetupStepId): void {
  if (typeof globalThis.localStorage === 'undefined') {
    return
  }
  try {
    const next = readEmittedSetupGuideStepIds()
    next.add(id)
    globalThis.localStorage.setItem(
      SETUP_GUIDE_TELEMETRY_COMPLETED_STEPS_STORAGE_KEY,
      JSON.stringify([...next])
    )
  } catch {
    // localStorage can be unavailable in hardened browser contexts; telemetry
    // is best-effort and must not block the setup-guide state transition.
  }
}

export function reserveTerminalPaneSplitTelemetry(
  source: TerminalPaneSplitSource,
  direction: 'vertical' | 'horizontal'
): boolean {
  if (typeof globalThis.localStorage === 'undefined') {
    return true
  }
  try {
    const emitted = readTerminalPaneSplitTelemetryKeys()
    const key = getTerminalPaneSplitTelemetryKey(source, direction, new Date())
    if (emitted.has(key)) {
      return false
    }
    emitted.add(key)
    globalThis.localStorage.setItem(
      TERMINAL_PANE_SPLIT_TELEMETRY_STORAGE_KEY,
      JSON.stringify([...emitted].slice(-32))
    )
    return true
  } catch {
    // Telemetry cost controls are best-effort; storage failures must not block split behavior.
    return true
  }
}

export function getSetupGuideStepSection(id: FeatureWallSetupStepId): 'parallel-work' | 'setup' {
  return SETUP_GUIDE_PARALLEL_WORK_STEP_IDS.has(id) ? 'parallel-work' : 'setup'
}

function emitFeatureEducationTelemetry<N extends FeatureEducationTelemetryEventName>(
  name: N,
  props: EventProps<N>
): void {
  track(name, props)
}

function clampTourStepCount(value: number, min = 0): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(8, Math.max(min, Math.round(value)))
}

function clampSetupGuideStepCount(value: number, min = 0): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(8, Math.max(min, Math.round(value)))
}

function readTerminalPaneSplitTelemetryKeys(): Set<string> {
  const raw = JSON.parse(
    globalThis.localStorage?.getItem(TERMINAL_PANE_SPLIT_TELEMETRY_STORAGE_KEY) ?? '[]'
  )
  if (!Array.isArray(raw)) {
    return new Set()
  }
  return new Set(raw.filter((value): value is string => typeof value === 'string'))
}

function getTerminalPaneSplitTelemetryKey(
  source: TerminalPaneSplitSource,
  direction: 'vertical' | 'horizontal',
  date: Date
): string {
  const day = Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : new Date(0).toISOString().slice(0, 10)
  return `${day}:${source}:${direction}`
}
