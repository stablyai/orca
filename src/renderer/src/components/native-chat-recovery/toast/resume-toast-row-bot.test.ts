import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { resumeRowBot } from './resume-toast-row-bot'

const UX_DESIGNER: Bot = {
  id: 'ux',
  name: 'UX Designer',
  hostId: 'local',
  folder: 'ux',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

describe('resumeRowBot', () => {
  it("names a bot's chats from its own host only, and never a terminal worker in its folder", () => {
    const chat = { workspaceId: 'folder:home-1' }
    expect(resumeRowBot([UX_DESIGNER], chat, 'local')?.name).toBe('UX Designer')
    // The same workspace id on a paired server is that server's chat, not this computer's bot.
    expect(resumeRowBot([UX_DESIGNER], chat, 'runtime:server-1')).toBeNull()
    expect(resumeRowBot([UX_DESIGNER], { ...chat, surface: 'terminal' }, 'local')).toBeNull()
  })
})
