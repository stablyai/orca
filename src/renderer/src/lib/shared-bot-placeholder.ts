// A shared agent its host hasn't listed here yet, as when it was found while that computer is away: a
// row from the cloud's word on the share alone, shown offline until the host's first read replaces it.
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { Bot } from '../../../shared/bot-types'
import type { SharedBotHostView } from '../../../shared/bots/shared-bot-hosts'

export function sharedBotPlaceholder(view: SharedBotHostView): Bot {
  return {
    id: view.botId,
    name: view.botName,
    // Stamped with the shared host's id when listed, like any host's own bots.
    hostId: LOCAL_EXECUTION_HOST_ID,
    folder: 'shared',
    folderWorkspaceId: `shared-${view.shareId}`,
    // The cloud doesn't say which agent it runs; nothing about the row depends on it until the host answers.
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 0,
    updatedAt: 0
  }
}
