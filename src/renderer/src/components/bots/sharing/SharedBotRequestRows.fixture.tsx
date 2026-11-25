import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { BotRow } from '../BotRow'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { SharedBotRequestList, SharedBotRequestRow } from './SharedBotRequestRows'

const BUILDER: SharedBotRequestView = {
  shareId: 'share-builder',
  botId: 'builder',
  botName: 'Release helper',
  ownerName: 'Jinwoo Hong',
  botPurpose: 'Drafts the release notes and checks every build before it ships.',
  agentCard: {
    mascot: 'H1',
    color: '#f4c4cf',
    outfit: 'tie',
    services: ['github', 'slack', 'linear', 'google']
  }
}

const NOTES: SharedBotRequestView = {
  shareId: 'share-notes',
  botId: 'notes',
  botName: 'Flaky test triage',
  ownerName: 'Neil Patel',
  agentCard: { mascot: 'E1', services: ['github'] }
}

function Sidebar({ requests }: { requests: SharedBotRequestView[] }): React.JSX.Element {
  return (
    <div className="flex w-[300px] flex-col gap-px rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 pl-1 text-worktree-sidebar-foreground">
      {requests.map((request) => (
        <SharedBotRequestRow key={request.shareId} request={request} />
      ))}
    </div>
  )
}

const rows = (frame: HTMLElement): HTMLElement[] => [
  ...frame.querySelectorAll<HTMLElement>('[role="button"][data-worktree-card-surface]')
]

/** A share offered to this account: the agent's row as it will be, dimmed, with the invite mark. */
export const invite = defineFixture({
  width: 340,
  render: () => <Sidebar requests={[BUILDER]} />
})

/** Two at once, the second focused from the keyboard; an older cloud's has no card, so its initial. */
export const twoInvites = defineFixture({
  width: 340,
  render: () => (
    <Sidebar
      requests={[NOTES, { ...BUILDER, shareId: 'share-plain', agentCard: undefined }, BUILDER]}
    />
  ),
  interact: (frame) => rows(frame)[1]?.focus()
})

/** View invite: what accepting means, with Accept and Decline. */
export const dialog = defineFixture({
  width: 340,
  render: () => <Sidebar requests={[BUILDER]} />,
  interact: (frame) => rows(frame)[0]?.click()
})

const AGENT: Bot = {
  id: 'windows',
  name: 'windows agent 2',
  hostId: 'local',
  folder: 'windows',
  folderWorkspaceId: 'fw-windows',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-windows',
  createdAt: 1,
  updatedAt: 1
}

const agentHome = makeFolderWorkspace({
  id: AGENT.folderWorkspaceId,
  name: AGENT.name,
  folderPath: '/agents/windows'
})

// The Bots list's own padding (SidebarBotsSection), so the rows sit as they do in the sidebar.
function AgentList({ folded }: { folded: boolean }): React.JSX.Element {
  return (
    <div className="relative flex w-[300px] flex-col rounded-lg border border-border bg-worktree-sidebar px-1 pt-1 pb-1 text-worktree-sidebar-foreground">
      <SharedBotRequestList requests={[BUILDER]} />
      <BotRow
        bot={AGENT}
        home={agentHome}
        isActive={false}
        onOpen={() => {}}
        fold={{
          folded,
          total: 2,
          counts: { permission: 0, working: 0, failed: 0 },
          onToggle: () => {}
        }}
      />
    </div>
  )
}

/** Draws a guide at the agent row's picture and name, and prints each row's x positions. */
function drawAlignmentGuides(frame: HTMLElement): void {
  for (const list of frame.querySelectorAll<HTMLElement>('[data-agent-list]')) {
    const box = list.firstElementChild!.getBoundingClientRect()
    const rows = [...list.querySelectorAll<HTMLElement>('[data-worktree-card-surface]')]
    const xs = rows.map((row) => {
      const picture = row.querySelector('span.relative')!.getBoundingClientRect()
      const name = row.querySelector('[class*="text-[13px]"]')!.getBoundingClientRect()
      return { picture: picture.left - box.left, size: picture.width, name: name.left - box.left }
    })
    const agent = xs.at(-1)!
    for (const x of [agent.picture, agent.name]) {
      const guide = document.createElement('div')
      guide.style.cssText = `position:absolute;top:0;bottom:0;left:${x}px;width:1px;background:#e5484d;pointer-events:none`
      list.firstElementChild!.appendChild(guide)
    }
    const label = document.createElement('div')
    label.className = 'text-[11px] text-muted-foreground'
    label.textContent = xs
      .map(
        (x, i) =>
          `${i === xs.length - 1 ? 'agent' : 'invite'}: picture x=${x.picture} (${x.size}px), name x=${x.name}`
      )
      .join(' · ')
    list.appendChild(label)
  }
}

/** An invite above an agent's row, folded and unfolded, with guides at the agent's picture and name. */
export const besideAgentRow = defineFixture({
  width: 340,
  setup: () => publishBots([AGENT], { threadReplies: false, webhooks: undefined }),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col gap-3 bg-background p-2">
        {[true, false].map((folded) => (
          <div key={String(folded)} data-agent-list="" className="flex flex-col gap-1">
            <AgentList folded={folded} />
          </div>
        ))}
      </div>
    </ConfirmationDialogProvider>
  ),
  interact: drawAlignmentGuides
})
