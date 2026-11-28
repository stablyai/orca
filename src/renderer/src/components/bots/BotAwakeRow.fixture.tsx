import { defineFixture } from '../../component-fixtures/component-fixture'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { publishBotNeedsYou } from '@/lib/bot-catalog-snapshot'
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

function awakeChatTabs(
  owners: readonly { id: string; folderWorkspaceId: string; chatSessionId: string }[]
) {
  return Object.fromEntries(
    owners.map((owner) => {
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
  )
}

export const awakeRows = defineFixture({
  width: 640,
  store: {
    agentStatusByPaneKey: acceptedAgentStatuses(
      awakeStatuses.map((entry) => [entry.paneKey, entry])
    ),
    unifiedTabsByWorktree: awakeChatTabs(awakeOwners),
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

const roster = (
  [
    ['Release manager', 'H1', 'Release notes are ready.', 0],
    ['Code reviewer', 'K2', 'Ready.', 2],
    ['Build engineer', 'A1', null, 0],
    ['Support triage', 'B1', 'Sorted the open tickets.', 0],
    ['Planning assistant', 'D1', 'Ready.', 1],
    ['Incident response', 'F1', 'Ready.', 3],
    ['Docs editor', 'G1', 'Updated the setup guide.', 0],
    ['Research assistant', 'M1', 'Ready.', 0],
    ['Test engineer', 'I1', 'Ready.', 1],
    ['Inbox assistant', 'E1', null, 0],
    ['Design reviewer', 'J1', 'Ready.', 2],
    ['Data analyst', 'L2', 'Checked the weekly report.', 0]
  ] as const
).map(([name, mascot, activity, count], index) => {
  const id = `roster-${index}`
  const owner = {
    ...fixtureCos,
    id,
    name,
    folderWorkspaceId: `fw-${id}`,
    chatSessionId: id,
    avatar: mascotAvatar(mascot)
  }
  const entry: AgentStatusEntry = {
    ...awakeStatuses[0],
    paneKey: chatPaneKey(id),
    worktreeId: folderWorkspaceKey(owner.folderWorkspaceId),
    state: activity ? 'done' : 'working',
    updatedAt: now - (index + 1) * 60_000,
    stateStartedAt: now - (index + 1) * 60_000,
    lastAssistantMessage: activity ?? undefined
  }
  return { owner, entry, count }
})

export const needsYouRows = defineFixture({
  width: 300,
  store: {
    agentStatusByPaneKey: acceptedAgentStatuses(roster.map(({ entry }) => [entry.paneKey, entry])),
    unifiedTabsByWorktree: awakeChatTabs(roster.map(({ owner }) => owner))
  },
  setup: () => {
    stubBots(roster.map(({ owner }) => owner))
    publishBotNeedsYou('local', {
      counts: Object.fromEntries(roster.map(({ owner, count }) => [owner.id, count])),
      at: now
    })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground">
        {roster.map(({ owner }, index) => (
          <BotRow
            key={owner.id}
            bot={owner}
            home={makeFolderWorkspace({
              id: owner.folderWorkspaceId,
              name: owner.name,
              isUnread: index === 3 || index === 4
            })}
            isActive={index === 1}
            onOpen={() => {}}
          />
        ))}
      </div>
    </ConfirmationDialogProvider>
  )
})
