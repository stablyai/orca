import { describe, expect, it } from 'vitest'
import { CONTEXTUAL_TOUR_IDS } from './contextual-tours'
import {
  FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS,
  normalizeFeatureEducationSource,
  normalizeSetupGuideSource
} from './feature-education-telemetry'

describe('feature education telemetry constants', () => {
  it('keeps contextual tour telemetry ids aligned with tour definitions', () => {
    expect(FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS).toEqual(CONTEXTUAL_TOUR_IDS)
  })

  it('normalizes unknown telemetry sources to a bounded fallback', () => {
    expect(normalizeFeatureEducationSource('tasks_open')).toBe('tasks_open')
    expect(normalizeFeatureEducationSource('workspace_agent_sessions_visible')).toBe(
      'workspace_agent_sessions_visible'
    )
    expect(normalizeFeatureEducationSource('floating_workspace_visible')).toBe(
      'floating_workspace_visible'
    )
    expect(normalizeFeatureEducationSource('setup_guide_parallel_work')).toBe(
      'setup_guide_parallel_work'
    )
    expect(normalizeFeatureEducationSource('https://example.com/private')).toBe('unknown')
    expect(normalizeFeatureEducationSource(null)).toBe('unknown')
  })

  it('normalizes setup guide telemetry sources to a bounded fallback', () => {
    expect(normalizeSetupGuideSource('sidebar')).toBe('sidebar')
    expect(normalizeSetupGuideSource('settings')).toBe('settings')
    expect(normalizeSetupGuideSource('help_menu')).toBe('help_menu')
    expect(normalizeSetupGuideSource('private-source')).toBe('unknown')
  })
})
