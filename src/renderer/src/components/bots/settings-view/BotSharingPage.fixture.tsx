// Settings › Sharing at page width: Teammates over Copy link, with nobody, two teammates, or both.
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { botPackageName } from '../../../../../shared/bots/bot-share-status'
import type { Bot } from '../../../../../shared/bot-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { BotSharingPage } from './BotSharingPage'

const builder: Bot = {
  id: 'bot-builder',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: false, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

// Dara is in; Sam is invited.
const withTeammates: Bot = {
  ...builder,
  shares: [
    {
      kind: 'account',
      shareId: 'share-dara',
      accountId: 'acct-dara',
      name: 'Dara Kim',
      email: 'dara@stably.ai',
      addedAt: 1,
      acceptedAt: 2
    },
    { kind: 'invite', shareId: 'share-sam', email: 'sam@northwind.dev', addedAt: 3 }
  ]
}

/** A cloud that takes shares, a host signed in as Jinwoo, and optionally the bot's live copy link. */
function stub(bot: Bot, link: boolean): void {
  Reflect.set(window.api, 'sharedBotHosts', {
    list: async () => ({ sharing: true, hosts: [], requests: [] }),
    onChanged: () => () => {}
  })
  installSharedBotHostCatalog()
  stubBots([bot], undefined, {
    results: {
      'orcaAccount.status': {
        state: 'signed-in',
        email: 'jinwoo@stably.ai',
        displayName: 'Jinwoo'
      },
      'bots.share.status': {
        status: 'ok',
        value: link
          ? [
              {
                id: 'k7Qm2xR9vTb4',
                url: 'https://app.onorca.dev/bots/share/k7Qm2xR9vTb4',
                packageId: 'package-1',
                name: botPackageName(builder.id),
                createdAt: '2026-10-30T15:00:00.000Z',
                canonical: true,
                pinnedVersionId: 'v2',
                pinnedPublishedAt: '2026-11-20T20:12:00.000Z',
                pinnedDigest: 'digest'
              }
            ]
          : []
      }
    }
  })
}

function at(bot: Bot, link: boolean) {
  return defineFixture({
    width: 900,
    setup: () => stub(bot, link),
    render: () => (
      <ConfirmationDialogProvider>
        <div className="settings-view-shell flex flex-col gap-[18px] bg-background px-8 pt-6 pb-12">
          <BotSharingPage bot={bot} />
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

export const none = at(builder, false)
export const teammates = at(withTeammates, false)
export const link = at(builder, true)
export const both = at(withTeammates, true)
