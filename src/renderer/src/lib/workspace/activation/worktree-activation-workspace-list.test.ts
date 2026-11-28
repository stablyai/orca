import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { showsWorkspaceList } from './worktree-activation-workspace-list'

function state(
  experimentalAppRail: boolean,
  botsEnabled: boolean
): Parameters<typeof showsWorkspaceList>[0] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only these settings.
  return {
    settings: { experimentalAppRail, botsEnabled } as AppState['settings'],
    orcaProfileAuthStatus: null
  }
}

describe('showsWorkspaceList', () => {
  const open = { navigationIntent: 'user-open' } as const

  it('shows Workspaces on a jump you made that reveals the workspace, with the inbox on', () => {
    expect(showsWorkspaceList(state(true, true), open)).toBe(true)
    expect(showsWorkspaceList(state(true, true), { ...open, revealInSidebar: true })).toBe(true)
  })

  it('stays in Activity when the switch is not yours (an agent, a capture restoring the last one)', () => {
    expect(showsWorkspaceList(state(true, true), undefined)).toBe(false)
    expect(showsWorkspaceList(state(true, true), { revealInSidebar: true })).toBe(false)
  })

  it("stays in Activity for Activity's own rows and a bot's Home, which do not reveal in the sidebar", () => {
    expect(showsWorkspaceList(state(true, true), { ...open, revealInSidebar: false })).toBe(false)
  })

  it('changes nothing with the rail or bots off, unless a caller asks', () => {
    expect(showsWorkspaceList(state(false, true), open)).toBe(false)
    expect(showsWorkspaceList(state(true, false), open)).toBe(false)
    expect(showsWorkspaceList(state(false, false), { showWorkspaceList: true })).toBe(true)
  })
})
