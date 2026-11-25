import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { SharedBotRequestRow } from './SharedBotRequestRows'

const IVY: SharedBotRequestView = {
  shareId: 'share-ivy',
  botId: 'ivy',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  botPurpose: 'Triages flaky tests and drafts the fix'
}

function Sidebar({ requests }: { requests: SharedBotRequestView[] }): React.JSX.Element {
  return (
    <div className="flex w-[280px] flex-col gap-px rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 pl-1 text-worktree-sidebar-foreground">
      {requests.map((request) => (
        <SharedBotRequestRow key={request.shareId} request={request} />
      ))}
    </div>
  )
}

/** A share offered to this account, at the top of Bots: who shared it, its purpose, Accept and Decline. */
export const request = defineFixture({
  width: 320,
  render: () => <Sidebar requests={[IVY]} />
})

/** Without a purpose line, and with a long one cut to the row. */
export const purposes = defineFixture({
  width: 320,
  render: () => (
    <Sidebar
      requests={[
        { ...IVY, shareId: 'a', botPurpose: undefined },
        {
          ...IVY,
          shareId: 'b',
          botName: 'Release notes for the desktop and phone apps',
          botPurpose:
            'Drafts the release notes for every desktop and phone release from the merged pull requests'
        }
      ]}
    />
  )
})
