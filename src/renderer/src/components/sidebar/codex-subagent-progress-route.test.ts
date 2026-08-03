import { describe, expect, it } from 'vitest'
import { resolveCodexSubagentProgressRoute } from './codex-subagent-progress-route'

describe('resolveCodexSubagentProgressRoute', () => {
  it('keeps local transcripts on the local transport', () => {
    expect(resolveCodexSubagentProgressRoute(null, 'unrelated-runtime')).toEqual({
      kind: 'readable',
      runtimeEnvironmentId: null
    })
  })

  it('routes runtime-owned transcripts to their remote runtime', () => {
    expect(resolveCodexSubagentProgressRoute('runtime-ssh-target-1', 'runtime-env-1')).toEqual({
      kind: 'readable',
      runtimeEnvironmentId: 'runtime-env-1'
    })
  })

  it('blocks runtime-owned transcripts until the runtime owner resolves', () => {
    expect(resolveCodexSubagentProgressRoute('runtime-ssh-target-1', null)).toEqual({
      kind: 'unavailable',
      reason: 'runtime-owner-missing'
    })
  })

  it('does not fall back to local reads for legacy SSH or unknown owners', () => {
    expect(resolveCodexSubagentProgressRoute('ssh-target-1', null)).toEqual({
      kind: 'unavailable',
      reason: 'legacy-ssh'
    })
    expect(resolveCodexSubagentProgressRoute(undefined, null)).toEqual({
      kind: 'unavailable',
      reason: 'unknown-owner'
    })
  })
})
