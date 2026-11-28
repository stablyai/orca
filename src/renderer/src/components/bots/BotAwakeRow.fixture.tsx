import { defineFixture } from '../../component-fixtures/component-fixture'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  structuredAgentSessionTabId,
  chatPaneKey
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotRow } from './BotRow'

const awakeOwners = (
  [
    ['awake-idle', 'Planning assistant', 'D1'],
    ['awake-done', 'Release assistant', 'H1'],
    ['awake-unread', 'Review assistant', 'K2']
  ] as const
).map(([id, name, mascot]) => ({
  ...fixtureCos,
  id,
  name,
  folder: id,
  folderWorkspaceId: `fw-${id}`,
  chatSessionId: `chat-${id}`,
  avatar: mascotAvatar(mascot)
}))
const now = Date.now()
const awakeStatuses: AgentStatusEntry[] = awakeOwners.slice(1).map((owner) => ({
  paneKey: chatPaneKey(owner.chatSessionId),
  worktreeId: folderWorkspaceKey(owner.folderWorkspaceId),
  agentType: 'claude',
  prompt: '',
  state: 'done',
  updatedAt: now - 60_000,
  stateStartedAt: now - 60_000,
  stateHistory: [],
  lastAssistantMessage: 'The review is ready.'
}))

export const awakeRows = defineFixture({
  width: 640,
  store: {
    agentStatusByPaneKey: acceptedAgentStatuses(
      awakeStatuses.map((entry) => [entry.paneKey, entry])
    ),
    unifiedTabsByWorktree: Object.fromEntries(
      awakeOwners.map((owner) => {
        const workspaceId = folderWorkspaceKey(owner.folderWorkspaceId)
        return [
          workspaceId,
          [
            makeUnifiedTab({
              id: structuredAgentSessionTabId(owner.chatSessionId),
              entityId: owner.chatSessionId,
              worktreeId: workspaceId,
              groupId: `group-${owner.id}`,
              contentType: 'agent-session',
              agentSessionAgent: 'claude'
            })
          ]
        ]
      })
    ),
    structuredChatSleptAtByPaneKey: Object.fromEntries(
      awakeOwners.map((owner) => [chatPaneKey(owner.chatSessionId), null])
    )
  },
  setup: () => stubBots(awakeOwners),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="grid grid-cols-2 gap-4 bg-background p-3">
        {awakeOwners.flatMap((owner, index) =>
          [false, true].map((selected) => (
            <div key={`${owner.id}-${selected}`} className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                {['Awake idle', 'Awake done', 'Awake unread'][index]} ·{' '}
                {selected ? 'Selected' : 'Unselected'}
              </span>
              <div className="rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground">
                <BotRow
                  bot={owner}
                  home={makeFolderWorkspace({
                    id: owner.folderWorkspaceId,
                    name: owner.name,
                    folderPath: `/bots/${owner.folder}`,
                    isUnread: index === 2
                  })}
                  isActive={selected}
                  onOpen={() => {}}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </ConfirmationDialogProvider>
  )
})
