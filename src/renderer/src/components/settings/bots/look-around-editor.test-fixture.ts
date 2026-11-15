import type { Bot } from '../../../../../shared/bot-types'

export const lookAroundEditorBot: Bot = {
  id: 'b1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1,
  lookAround: {
    on: true,
    every: 'custom',
    times: ['09:30', '14:00'],
    weekdaysOnly: true,
    focus: '',
    timezone: 'UTC'
  }
}
