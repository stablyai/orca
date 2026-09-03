import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-title-status'

// Why: the idle/working matchers are boundary-aware precisely because a title
// carries the cwd; the permission check next to them was a bare substring.
describe('detectAgentStatusFromTitle permission matching', () => {
  it('does not read a permission-shaped path segment as a permission prompt', () => {
    expect(detectAgentStatusFromTitle('Claude ready — ~/repo/permissions')).toBe('idle')
    expect(detectAgentStatusFromTitle('Claude done — ~/work/permissions-audit')).toBe('idle')
    expect(detectAgentStatusFromTitle('Claude working — /home/u/awaiting-review')).toBe('working')
    expect(detectAgentStatusFromTitle('Claude working — C:\\src\\permissions')).toBe('working')
    // Why both ends: `permissions/` is a common directory name, so the keyword
    // lands at the start of a path segment too, not only at its end.
    expect(detectAgentStatusFromTitle('Claude ready — permissions/foo')).toBe('idle')
    expect(detectAgentStatusFromTitle('Claude ready — permissions\\foo')).toBe('idle')
  })

  it('still reads a real permission prompt', () => {
    expect(detectAgentStatusFromTitle('Claude - action required')).toBe('permission')
    expect(detectAgentStatusFromTitle('Claude — permission needed')).toBe('permission')
    expect(detectAgentStatusFromTitle('Claude — 2 permissions pending')).toBe('permission')
    expect(detectAgentStatusFromTitle('Claude — waiting for input')).toBe('permission')
  })

  it('leaves the boundary-aware idle and working matchers alone', () => {
    expect(detectAgentStatusFromTitle('Claude ready — ~/src/auth')).toBe('idle')
    expect(detectAgentStatusFromTitle('Claude — reworking the parser')).toBe('idle')
  })
})
