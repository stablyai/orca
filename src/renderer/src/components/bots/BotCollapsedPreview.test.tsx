// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { Bot } from '../../../../shared/bot-types'

const state = {
  workspaceLineageByChildKey: {},
  worktreeLineageById: {},
  worktreesByRepo: {},
  folderWorkspaces: []
}
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-statuses', () => ({
  useWorktreeActivityStatuses: () => new Map()
}))
// The bot has new Up next suggestions; they must not read as unread.
vi.mock('@/lib/bot-up-next-unseen', () => ({
  useBotUpNextUnseen: () => 2,
  useBotUpNextUnseenCounts: () => ({ b1: 2 })
}))

import { useBotPreviewFacts } from './BotCollapsedPreview'

const bot: Bot = {
  id: 'b1',
  name: 'Triage bot',
  hostId: 'local',
  folder: 'b1',
  folderWorkspaceId: 'fw-b1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-b1',
  createdAt: 1,
  updatedAt: 1
}

describe('useBotPreviewFacts', () => {
  it('does not count new Up next suggestions as unread', () => {
    const home = makeFolderWorkspace({ id: 'fw-b1', isUnread: false })
    const rows = [{ bot, home }]
    const { result } = renderHook(() => useBotPreviewFacts(rows))
    expect(result.current[0]!.unread).toBe(false)
  })

  it('still counts the home being unread', () => {
    const home = makeFolderWorkspace({ id: 'fw-b1', isUnread: true })
    const rows = [{ bot, home }]
    const { result } = renderHook(() => useBotPreviewFacts(rows))
    expect(result.current[0]!.unread).toBe(true)
  })
})
