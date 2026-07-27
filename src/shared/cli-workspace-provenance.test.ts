import { describe, expect, it } from 'vitest'
import { buildCliWorkspaceProvenance } from './cli-workspace-provenance'

describe('buildCliWorkspaceProvenance', () => {
  it('returns undefined when the caller sent no CLI provenance request', () => {
    // Why: desktop/mobile/automation creates must stay unmarked.
    expect(buildCliWorkspaceProvenance(undefined, { createdAt: 5 })).toBeUndefined()
  })

  it('marks a bare create with the host-stamped timestamp', () => {
    expect(buildCliWorkspaceProvenance({}, { createdAt: 5 })).toEqual({
      kind: 'created-by-cli',
      createdAt: 5
    })
  })

  it('ignores a client-supplied createdAt so a skewed CLI clock cannot drive sort order', () => {
    const provenance = buildCliWorkspaceProvenance(
      { createdAt: 9_999 } as Parameters<typeof buildCliWorkspaceProvenance>[0],
      { createdAt: 5 }
    )
    expect(provenance?.createdAt).toBe(5)
  })

  it('records the caller terminal handle for agent-issued creates', () => {
    expect(
      buildCliWorkspaceProvenance({ callerTerminalHandle: 'term-1' }, { createdAt: 5 })
    ).toEqual({
      kind: 'created-by-cli',
      createdAt: 5,
      callerTerminalHandle: 'term-1'
    })
  })

  it('omits an empty terminal handle rather than persisting a blank field', () => {
    expect(buildCliWorkspaceProvenance({ callerTerminalHandle: '' }, { createdAt: 5 })).toEqual({
      kind: 'created-by-cli',
      createdAt: 5
    })
  })

  it('records the startup agent when the create passed --agent', () => {
    expect(buildCliWorkspaceProvenance({}, { createdAt: 5, startupAgent: 'claude' })).toEqual({
      kind: 'created-by-cli',
      createdAt: 5,
      startupAgent: 'claude'
    })
  })
})
