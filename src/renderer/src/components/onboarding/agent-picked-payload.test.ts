import { describe, expect, it } from 'vitest'
import { buildAgentPickedPayload } from './agent-picked-payload'

describe('buildAgentPickedPayload', () => {
  it('attaches path_source and path_failure_reason from the store snapshot', () => {
    const payload = buildAgentPickedPayload({
      agent: 'claude',
      detectedAgentIds: ['claude'],
      isDetecting: false,
      fromCollapsedSection: false,
      pathSource: 'sync_seed_only',
      pathFailureReason: 'timeout'
    })

    expect(payload).toEqual({
      agent_kind: 'claude-code',
      on_path: true,
      detected_count: 1,
      detection_state: 'complete',
      from_collapsed_section: false,
      path_source: 'sync_seed_only',
      path_failure_reason: 'timeout'
    })
  })

  it('reports on_path:false and the seed-only source for the headline triage case', () => {
    const payload = buildAgentPickedPayload({
      agent: 'claude',
      detectedAgentIds: [],
      isDetecting: false,
      fromCollapsedSection: false,
      pathSource: 'sync_seed_only',
      pathFailureReason: 'empty_path'
    })

    expect(payload.on_path).toBe(false)
    expect(payload.path_source).toBe('sync_seed_only')
    expect(payload.path_failure_reason).toBe('empty_path')
  })

  it('omits the path fields when the store snapshot has not resolved yet', () => {
    // Optional strict-schema fields reject null and would drop the event; omit unresolved path evidence.
    const payload = buildAgentPickedPayload({
      agent: 'codex',
      detectedAgentIds: ['codex'],
      isDetecting: true,
      fromCollapsedSection: false,
      pathSource: null,
      pathFailureReason: null
    })

    expect(payload).toEqual({
      agent_kind: 'codex',
      on_path: true,
      detected_count: 1,
      detection_state: 'pending',
      from_collapsed_section: false
    })
    expect('path_source' in payload).toBe(false)
    expect('path_failure_reason' in payload).toBe(false)
  })

  it('reports detection_state=pending while the refresh is in flight', () => {
    const payload = buildAgentPickedPayload({
      agent: 'codex',
      detectedAgentIds: [],
      isDetecting: true,
      fromCollapsedSection: false,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })

    expect(payload.detection_state).toBe('pending')
  })
})
