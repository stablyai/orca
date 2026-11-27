import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubUsageLimitFeed } from '../../component-fixtures/fixture-usage-limit-feed'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotRow } from './BotRow'
import { cn } from '@/lib/class-names'

const now = Date.now()
const MIN = 60_000

function bot(id: string): Bot {
  return {
    id,
    name: 'Eng - Dev Ops',
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    createdAt: 1,
    updatedAt: 1
  }
}

const devOpsOn = bot('devops-on')
const devOpsOff = bot('devops-off')
const longName = {
  ...bot('long-name'),
  name: 'Eng - Release Coordination and Infrastructure Reviewer'
}
const owners = [devOpsOn, devOpsOff, longName]
const LIMIT_RESET = now + 40 * MIN

const chats: AgentStatusEntry[] = owners.map((owner) => ({
  paneKey: structuredAgentSessionStatusPaneKey(`chat-${owner.id}`),
  worktreeId: folderWorkspaceKey(owner.folderWorkspaceId),
  agentType: 'claude',
  prompt: '',
  state: 'done',
  updatedAt: now - 240 * MIN,
  stateStartedAt: now - 240 * MIN,
  stateHistory: [],
  lastAssistantMessage: 'I removed nothing: none of the 31 qa-*-qg worktrees are stale.'
}))

/** Its Look around run stopped on the usage limit: the same mark whether Orca continues it or not. */
export const usageLimitRows = defineFixture({
  width: 640,
  store: {
    agentStatusByPaneKey: acceptedAgentStatuses(chats.map((entry) => [entry.paneKey, entry]))
  },
  setup: () => {
    publishBots(owners, { threadReplies: false, webhooks: undefined, waits: {} })
    stubUsageLimitFeed(
      owners.map((owner) => ({
        sessionId: `look-${owner.id}`,
        workspaceId: folderWorkspaceKey(owner.folderWorkspaceId),
        name: 'Look around',
        resetsAt: LIMIT_RESET,
        auto: owner === devOpsOn
      }))
    )
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-wrap items-start gap-4 bg-background p-3">
        {(
          [
            ['Auto-continue on', devOpsOn],
            ['Auto-continue off', devOpsOff],
            ['Longest name, narrow', longName]
          ] as const
        ).map(([label, owner]) => (
          <div key={label} className="flex flex-col gap-1.5">
            <div className="text-[11px] text-muted-foreground">{label}</div>
            <div
              className={cn(
                'flex flex-col rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground',
                owner === longName ? 'w-[200px]' : 'w-[280px]'
              )}
            >
              <BotRow
                bot={owner}
                home={makeFolderWorkspace({
                  id: owner.folderWorkspaceId,
                  name: owner.name,
                  folderPath: `/bots/${owner.folder}`
                })}
                isActive={owner === devOpsOn}
                onOpen={() => {}}
              />
            </div>
          </div>
        ))}
      </div>
    </ConfirmationDialogProvider>
  )
})
