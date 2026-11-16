import { describe, expect, it } from 'vitest'
import { sidebarRestartOffered } from './CloudWorkspaceMenuItems'

// The menu's on-open status refresh keeps the last status while it reads, so rows change only
// when the state really changes. Before the first read, Restart holds its place (disabled) so the
// usual answer, running, moves nothing under the pointer.
describe('sidebar Restart row', () => {
  it('holds its place while the status is unknown', () => {
    expect(sidebarRestartOffered('unknown')).toBe(true)
  })

  it('is offered for a workspace that answers or failed, not one asleep or archived', () => {
    expect(sidebarRestartOffered('running')).toBe(true)
    expect(sidebarRestartOffered('unresponsive')).toBe(true)
    expect(sidebarRestartOffered('failed')).toBe(true)
    expect(sidebarRestartOffered('sleeping')).toBe(false)
    expect(sidebarRestartOffered('archived')).toBe(false)
  })
})
