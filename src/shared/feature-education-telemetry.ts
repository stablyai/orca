import type { ContextualTourId } from './contextual-tours'

export const FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS = [
  'workspace-board',
  'workspace-agent-sessions',
  'browser',
  'tasks',
  'automations',
  'workspace-creation'
] as const satisfies readonly ContextualTourId[]

export const FEATURE_EDUCATION_SOURCES = [
  'workspace_board_visible',
  'workspace_agent_sessions_visible',
  'browser_visible',
  'tasks_open',
  'automations_open',
  'workspace_creation_visible',
  'workspace_creation_modal',
  'setup_guide_parallel_work',
  'unknown'
] as const

export const CONTEXTUAL_TOUR_OUTCOMES = ['completed', 'skipped', 'cancelled'] as const

export type FeatureEducationSource = (typeof FEATURE_EDUCATION_SOURCES)[number]
export type ContextualTourOutcome = (typeof CONTEXTUAL_TOUR_OUTCOMES)[number]

export function normalizeFeatureEducationSource(
  value: string | null | undefined
): FeatureEducationSource {
  return FEATURE_EDUCATION_SOURCES.includes(value as FeatureEducationSource)
    ? (value as FeatureEducationSource)
    : 'unknown'
}
