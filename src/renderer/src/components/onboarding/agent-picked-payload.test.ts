import { describe, expect, it } from 'vitest'
import { buildAgentPickedPayload } from './agent-picked-payload'

// Why: this test guards the renderer-end attachment of `path_source` and
// `path_failure_reason` to `onboarding_agent_picked`. Without it the entire
// instrument-first plan in docs/agent-on-path-detection.md can ship dark for
// two weeks before a dashboard read shows the fields are null-only.

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
    // Why: this is the dominant row the instrumentation exists to interpret —
    // a claude-code pick that read on_path:false because hydration failed,
    // not because the user is missing the binary.
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
    // Why: pre-refresh clicks must NOT emit `path_source: null`. The schema
    // declares both fields as `.optional()`, so a literal `null` would fail
    // `.strict()` validation and drop the entire event.
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

  it('forwards from_collapsed_section verbatim', () => {
    const payload = buildAgentPickedPayload({
      agent: 'aider',
      detectedAgentIds: [],
      isDetecting: false,
      fromCollapsedSection: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })

    expect(payload.from_collapsed_section).toBe(true)
  })
})
