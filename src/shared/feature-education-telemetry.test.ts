import { describe, expect, it } from 'vitest'
import {
  normalizeFeatureEducationSource,
  normalizeSetupGuideSource
} from './feature-education-telemetry'

describe('feature education telemetry constants', () => {
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
