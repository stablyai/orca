// The Slack connector's section in the Connectors panel (350 and 280 px) and the after-install
// dialog: Who can ask as one list, and who messages typed in Orca show as.
import React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots, setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { refreshAccessRequests } from '@/lib/bot-access-requests'
import type { Bot } from '../../../../../shared/bot-types'
import { BotConnectorsSection } from '../../settings/bots/BotConnectorsSection'
import { clickWhenShown, settle, slackOnly, stub } from '../bot-connectors-host-fixture'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import { BotSlackSection } from './BotSlackSection'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import portrait from '../../../component-fixtures/assets/slack-avatar.jpg'
import { connectorAvatarSrc } from '../../../../../shared/connector-avatar-scheme'
import { botSlackIconLook } from '../../../../../shared/bots/bot-slack-icon'
import { botRefKey } from '@/lib/bot-hosts'
import { slackIconFailures } from '../bot-slack-icon-failures'

// The Slack photo's address; the host's avatar cache is played by a bundled portrait wherever its
// cached src is drawn, so the shot never waits on the network.
const PHOTO = 'https://avatars.slack-edge.com/fixture/alice_72.jpg'
function serveCachedAvatars(): void {
  const serve = (img: HTMLImageElement): void => {
    if (img.src === connectorAvatarSrc(PHOTO)) {
      img.src = portrait
    }
  }
  new MutationObserver(() => document.querySelectorAll('img').forEach(serve)).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src']
  })
}

const builder: Bot = { ...slackOnly, name: 'Eng-Bot-Builder', members: [] }
const shared: Bot = {
  ...builder,
  members: [{ id: 'U-sam', name: 'Sam Lee', source: 'slack', workspaceId: 'T1' }]
}

const installed = (fields: Record<string, unknown> = {}) => ({
  state: 'installed',
  teamId: 'T1',
  teamName: 'Globex',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U-alice',
  installerName: 'Alice',
  postAs: 'person',
  computerName: 'm4 air',
  ...fields
})

function host(bot: Bot, options: { requests?: boolean; photo?: boolean } = {}): void {
  stub({ linearLinked: false, composio: false })
  serveCachedAvatars()
  const poster = options.photo === false ? { name: 'Alice' } : { name: 'Alice', avatarUrl: PHOTO }
  publishBots([bot])
  Reflect.set(window.api, 'botSlack', {
    members: async () => ({ ok: false, error: 'fixture' }),
    state: async () => ({ ok: true, value: installed({ poster }) }),
    setPostAs: async () => ({
      ok: true,
      value: { appId: 'A1', authorizeUrl: 'https://slack.com/oauth/v2/authorize?state=fixture' }
    })
  })
  const call = window.api.runtime.call
  window.api.runtime.call = async (args) =>
    args.method === 'bots.access.list'
      ? {
          id: 'access-list',
          ok: true,
          _meta: { runtimeId: 'fixture' },
          result: {
            ok: true,
            value: options.requests
              ? [
                  {
                    requestId: 'r1',
                    botId: bot.id,
                    source: 'slack',
                    workspaceId: 'T1',
                    workspaceName: 'Globex',
                    requester: { id: 'U-dana', name: 'Dana Kim', handle: 'dana', detail: '' },
                    createdAt: Date.now() - 4 * 60_000,
                    expiresAt: Date.now() + 86_400_000
                  }
                ]
              : []
          }
        }
      : call(args)
  void refreshAccessRequests()
}

// The Connectors tab at a sidebar width: its own container, as BotConnectorsPanel draws it.
const Sidebar = ({ bot, width }: { bot: Bot; width: number }): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <div
      style={{ width }}
      className="@container/connectors-panel bg-sidebar px-2 py-3 text-sidebar-foreground"
    >
      <BotConnectorsSection bot={bot} />
    </div>
  </ConfirmationDialogProvider>
)

const openRow = () =>
  clickWhenShown(
    (button) =>
      button.getAttribute('aria-expanded') === 'false' &&
      button.getAttribute('aria-controls') !== null &&
      button.textContent?.startsWith('Slack') === true
  )
const openPicker = async () => {
  await settle(300)
  await clickWhenShown((button) => button.textContent?.trim() === 'Alice')
  await settle(100)
  await Promise.all(
    [...document.querySelectorAll<HTMLImageElement>('[role="radio"] img')].map((img) =>
      img.decode().catch(() => {})
    )
  )
}
const pickComputer = async () => {
  await openPicker()
  await settle(200)
  const option = document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')
  option?.click()
  await settle(200)
}

const panel = (width: number, bot: Bot, extra?: () => Promise<void>, requests = false) =>
  defineFixture({
    width: width + 40,
    setup: () => host(bot, { requests }),
    render: () => <Sidebar bot={bot} width={width} />,
    interact: async () => {
      await openRow()
      await settle(300)
      await extra?.()
    }
  })

export const panel350OnlyYou = panel(350, builder)
export const panel350OnePerson = panel(350, shared)
export const panel350Request = panel(350, builder, undefined, true)
export const panel350Picker = panel(350, builder, openPicker)
export const panel350Approval = panel(350, builder, pickComputer)
export const panel280OnlyYou = panel(280, builder)
export const panel280OnePerson = panel(280, shared)
export const panel280Request = panel(280, builder, undefined, true)
export const panel280Picker = panel(280, builder, openPicker)
export const panel280Approval = panel(280, builder, pickComputer)

const dialog = (interact?: () => Promise<void>, photo = true) =>
  defineFixture({
    width: 1100,
    setup: () => host(builder, { photo }),
    render: () => (
      <ConfirmationDialogProvider>
        <BotSlackSetupDialog bot={builder} teamId="T1" open onOpenChange={() => {}} />
      </ConfirmationDialogProvider>
    ),
    ...(interact ? { interact } : {})
  })

export const afterInstall = dialog()
export const afterInstallPicker = dialog(openPicker)
export const afterInstallPickerNoPhoto = dialog(openPicker, false)

// A dressed mascot whose colored picture this window failed to send to Slack: the note and its Try again.
const dressed: Bot = {
  ...builder,
  avatar: 'mascot:B1',
  avatarColor: '#f4c4cf',
  avatarOutfit: 'party'
}
const installedSlack: Extract<ConnectorBotSlackState, { state: 'installed' }> = {
  state: 'installed',
  teamId: 'T1',
  teamName: 'Globex',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U-alice',
  installerName: 'Alice',
  postAs: 'person',
  computerName: 'm4 air'
}
// The bot on a paired computer that is away: the note says when it goes, with no Try again.
const away: Bot = stampBotHost(toRuntimeExecutionHostId('studio'), dressed)
const iconFailed = (width: number, bot: Bot = dressed) =>
  defineFixture({
    width: width + 40,
    setup: () => {
      host(bot)
      if (bot === away) {
        setBotHostListing({ hosts: [{ hostId: away.hostId, state: 'offline' }], updateNeeded: [] })
      }
      slackIconFailures.set(botRefKey(bot), { look: botSlackIconLook(bot) ?? '', count: 1 })
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div style={{ width }} className="bg-sidebar px-2 py-3 text-sidebar-foreground">
          <BotSlackSection bot={bot} slack={installedSlack} />
        </div>
      </ConfirmationDialogProvider>
    ),
    interact: async () => {
      await settle(300)
    }
  })

export const panel350IconFailed = iconFailed(350)
export const panel280IconFailed = iconFailed(280)
export const panel350IconFailedAway = iconFailed(350, away)
