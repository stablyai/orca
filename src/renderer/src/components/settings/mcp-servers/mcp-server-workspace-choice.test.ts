import { describe, expect, it } from 'vitest'
import {
  isMcpWorkspaceOn,
  withMcpWorkspace,
  withMcpWorkspacesLater
} from './mcp-server-workspace-choice'

// The stored `{later, on, off}` is what the host delivers by: a checklist edit must change only the
// workspace clicked, never one that was on or off implicitly through `later`.
describe('MCP server workspaces checklist', () => {
  const known = ['orca', 'orca-docs', 'mobile-app']

  it('keeps every known workspace as it was when "added later" flips', () => {
    const allButDocs = { later: true, on: [], off: ['orca-docs'] }
    const only = withMcpWorkspacesLater(allButDocs, known, false)
    expect(only).toEqual({ later: false, on: ['orca', 'mobile-app'], off: [] })
    expect(known.map((key) => isMcpWorkspaceOn(only, key))).toEqual([true, false, true])
    expect(isMcpWorkspaceOn(only, 'added-tomorrow')).toBe(false)

    const back = withMcpWorkspacesLater(only, known, true)
    expect(back).toEqual(allButDocs)
  })

  it('changes only the workspace clicked', () => {
    const onlyOrca = { later: false, on: ['orca'], off: [] }
    const both = withMcpWorkspace(onlyOrca, 'mobile-app', true)
    expect(both).toEqual({ later: false, on: ['orca', 'mobile-app'], off: [] })
    expect(withMcpWorkspace(both, 'orca', false)).toEqual({
      later: false,
      on: ['mobile-app'],
      off: []
    })
  })
})
