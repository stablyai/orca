import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { SharedBotRequestRow } from './SharedBotRequestRows'

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
