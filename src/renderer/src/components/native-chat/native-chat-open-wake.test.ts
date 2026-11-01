import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { takeNativeChatOpenWake } from './native-chat-open-wake'

const LEAF = '11111111-1111-4111-8111-111111111111'

function tabs(entries: Record<string, string[]>): AppState['tabsByWorktree'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake only reads each tab's id.
  return Object.fromEntries(
    Object.entries(entries).map(([worktreeId, ids]) => [worktreeId, ids.map((id) => ({ id }))])
  ) as unknown as AppState['tabsByWorktree']
}

describe('takeNativeChatOpenWake (E9)', () => {
  beforeEach(() => resetWorkspaceSwitchUserActsForTests())

  it('a chat in another workspace mounting inside the switch window neither wakes nor spends the switch', () => {
    const byWorktree = tabs({ 'wt-a': ['tab-a'], 'wt-b': ['tab-b'] })
    noteUserWorkspaceSwitch('wt-a')
    expect(takeNativeChatOpenWake(makePaneKey('tab-b', LEAF), 'chat-b', byWorktree)).toBe(false)
    expect(takeNativeChatOpenWake(makePaneKey('tab-a', LEAF), 'chat-a', byWorktree)).toBe(true)
    // Once per switch: a remount of the same chat does not wake again.
    expect(takeNativeChatOpenWake(makePaneKey('tab-a', LEAF), 'chat-a', byWorktree)).toBe(false)
  })

  it('a chat whose tab belongs to no workspace never wakes', () => {
    noteUserWorkspaceSwitch('wt-a')
    expect(takeNativeChatOpenWake(makePaneKey('tab-x', LEAF), 'chat-x', tabs({}))).toBe(false)
    expect(takeNativeChatOpenWake('not-a-pane-key', 'chat-x', tabs({ 'wt-a': ['tab-a'] }))).toBe(
      false
    )
  })
})
