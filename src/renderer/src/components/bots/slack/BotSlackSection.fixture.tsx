// The Slack connector's section in the Connectors panel (350 and 280 px) and the after-install
// dialog: Who can ask as one list, who messages typed in Orca show as, and the channel intro switch.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { refreshAccessRequests } from '@/lib/bot-access-requests'
import type { Bot } from '../../../../../shared/bot-types'
import { clickWhenShown, Panel, settle, slackOnly, stub } from '../bot-connectors-host-fixture'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import portrait from '../../../component-fixtures/assets/slack-avatar.jpg'
import { connectorAvatarSrc } from '../../../../../shared/connector-avatar-scheme'

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

function host(
  bot: Bot,
  options: { requests?: boolean; photo?: boolean; intro?: boolean } = {}
): void {
  stub({ linearLinked: false, composio: false })
  serveCachedAvatars()
  const poster = options.photo === false ? { name: 'Alice' } : { name: 'Alice', avatarUrl: PHOTO }
  // The host's bot as it saves it, so a switch flipped here reads back as flipped.
  let saved = bot
  const facts = { threadReplies: false, webhooks: undefined, slackChannelHello: options.intro }
  publishBots([bot], facts)
  Reflect.set(window.api, 'botSlack', {
    members: async () => ({ ok: false, error: 'fixture' }),
    state: async () => ({ ok: true, value: installed({ poster }) }),
    setPostAs: async () => ({
      ok: true,
      value: { appId: 'A1', authorizeUrl: 'https://slack.com/oauth/v2/authorize?state=fixture' }
    })
  })
  const call = window.api.runtime.call
  const answer = (id: string, result: unknown) => ({
    id,
    ok: true as const,
    _meta: { runtimeId: 'fixture' },
    result
  })
  window.api.runtime.call = async (args) =>
    args.method === 'bots.update'
      ? answer('update', {
          bot: (saved = {
            ...saved,
            ...(args.params as { updates: Partial<Bot> }).updates
          })
        })
      : args.method === 'bots.list'
        ? answer('list', { bots: [saved], ...facts })
        : args.method === 'bots.access.list'
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

// The workspace's own page, opened from its row in the list.
const openPage = () =>
  clickWhenShown((button) => button.textContent?.startsWith('Slack · Globex') === true)

const panel = (
  width: number,
  bot: Bot,
  extra?: () => Promise<void>,
  requests = false,
  intro?: boolean
) =>
  defineFixture({
    width: width + 40,
    setup: () => host(bot, { requests, intro }),
    render: () => <Panel bot={bot} width={width} />,
    interact: async () => {
      await (intro === undefined ? openRow() : openPage())
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

// The channel intro switch, where the host's Orca Cloud honours it; elsewhere the row isn't drawn.
const quiet: Bot = { ...builder, slackChannelHello: false }
const twoWorkspaces: Bot = {
  ...builder,
  slackApps: [
    ...(builder.slack ? [builder.slack] : []),
    ...(builder.slack ? [{ ...builder.slack, teamId: 'T2', appId: 'A2' }] : [])
  ]
}
const flipIntro = async () => {
  await settle(200)
  document
    .querySelector<HTMLElement>(
      '[role="switch"][aria-label="Post an intro when added to a channel"]'
    )
    ?.click()
  await settle(300)
}
export const panel350Intro = panel(350, builder, undefined, false, true)
export const panel350IntroOff = panel(350, quiet, undefined, false, true)
export const panel350IntroFlipped = panel(350, builder, flipIntro, false, true)
export const panel350IntroTwoWorkspaces = panel(350, twoWorkspaces, undefined, false, true)
export const panel280Intro = panel(280, builder, undefined, false, true)

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
