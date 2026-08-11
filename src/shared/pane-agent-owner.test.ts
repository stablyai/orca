import { describe, expect, it } from 'vitest'
import { resolvePaneAgentOwner } from './pane-agent-owner'

describe('resolvePaneAgentOwner', () => {
  it('leads with launch intent', () => {
    expect(
      resolvePaneAgentOwner({ launchAgent: 'omp', hookAgent: 'pi', sleepingSessionAgent: 'claude' })
    ).toBe('omp')
    expect(resolvePaneAgentOwner({ startupLaunchAgent: 'codex', hookAgent: 'claude' })).toBe(
      'codex'
    )
    expect(
      resolvePaneAgentOwner({ initialStatusAgent: 'gemini', commandInferredAgent: 'codex' })
    ).toBe('gemini')
  })

  it('falls through to the durable host-stamped hook identity when launch intent is gone', () => {
    // The mirror/restore case: launchAgent dropped, live hook is the anchor.
    expect(resolvePaneAgentOwner({ hookAgent: 'omp' })).toBe('omp')
    // Live hook cleared: the last completed hook carries the identity.
    expect(resolvePaneAgentOwner({ completedHookAgent: 'omp' })).toBe('omp')
    // Nothing live at all: the hibernated session record is the last resort.
    expect(resolvePaneAgentOwner({ sleepingSessionAgent: 'omp' })).toBe('omp')
  })

  it('ranks live/recent evidence above the hibernated record so a stale record cannot hijack', () => {
    expect(resolvePaneAgentOwner({ hookAgent: 'pi', sleepingSessionAgent: 'omp' })).toBe('pi')
    expect(resolvePaneAgentOwner({ completedHookAgent: 'pi', sleepingSessionAgent: 'omp' })).toBe(
      'pi'
    )
  })

  it('prefers focused over sibling evidence at each tier', () => {
    expect(resolvePaneAgentOwner({ hookAgent: 'omp', siblingHookAgent: 'pi' })).toBe('omp')
    expect(
      resolvePaneAgentOwner({ completedHookAgent: 'omp', siblingCompletedHookAgent: 'pi' })
    ).toBe('omp')
  })

  it('returns null when no owner evidence exists', () => {
    expect(resolvePaneAgentOwner({})).toBeNull()
    expect(resolvePaneAgentOwner({ launchAgent: null, hookAgent: undefined })).toBeNull()
  })
})
