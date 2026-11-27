import { defineFixture } from '../../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { refreshBotDiscord } from '@/lib/bot-discord-state'
import type { Bot, BotDiscordGuild } from '../../../../../shared/bot-types'
import type { ConnectorDiscordBot } from '../../../../../shared/connector-bot-discord-contract'
import { BotDiscordCard } from './BotDiscordCard'
import { BotDiscordSetupDialog } from './BotDiscordSetupDialog'

const triage: Bot = {
  id: 'bot-triage',
  name: 'Triage bot',
  hostId: 'local',
  folder: 'triage',
  folderWorkspaceId: 'fw-triage',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const acme: BotDiscordGuild = {
  guildId: '900000000000000001',
  guildName: 'Acme',
  roles: [{ id: '700000000000000001', name: 'Engineers' }],
  channels: [
    { id: '800000000000000001', name: 'support' },
    { id: '800000000000000002', name: 'deploys' }
  ]
}

const inAcme: Bot = {
  ...triage,
  discord: { applicationId: '500000000000000001', guilds: [acme] },
  members: [
    { id: '111000000000000001', name: 'Sam Lee', source: 'discord', workspaceId: acme.guildId },
    { id: '111000000000000002', name: 'Bea Park', source: 'discord', workspaceId: acme.guildId }
  ]
}
const inNone: Bot = { ...triage, discord: { applicationId: '500000000000000001', guilds: [] } }

const ready = (guilds: { guildId: string; name: string }[]): ConnectorDiscordBot => ({
  botId: triage.id,
  state: 'ready',
  applicationId: '500000000000000001',
  botUserId: '500000000000000001',
  botName: 'Triage bot',
  ownerUserId: '111000000000000000',
  ownerName: 'dana',
  guilds
})
const revoked: ConnectorDiscordBot = {
  botId: triage.id,
  state: 'broken',
  applicationId: '500000000000000001',
  reason: 'token_revoked'
}

function stubDiscord(bots: ConnectorDiscordBot[] | 'off', shown: Bot[] = [triage]): void {
  publishBots(shown)
  Reflect.set(window.api, 'botDiscord', {
    bots: async () =>
      bots === 'off' ? { ok: false, error: 'discord_off' } : { ok: true, value: { bots } },
    guild: async () => ({
      ok: true,
      value: {
        roles: [
          { id: '700000000000000001', name: 'Engineers' },
          { id: '700000000000000002', name: 'Support' }
        ],
        channels: [{ id: '800000000000000001', name: 'support', kind: 'text' }]
      }
    }),
    members: async () => ({ ok: false, error: 'fixture' })
  })
  // The page stays warm between fixtures: an answer an earlier one left must not show here.
  withBotConnectorRuntime(window.api)
  void refreshBotDiscord('local')
}

const dialog = (bot: Bot = triage, guildId?: string): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <BotDiscordSetupDialog bot={bot} guildId={guildId} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)

const card = (bot: Bot, guild: BotDiscordGuild | null, defaultOpen = false): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <BotDiscordCard bot={bot} guild={guild} defaultOpen={defaultOpen} />
  </ConfirmationDialogProvider>
)

const acmeNow = { guildId: acme.guildId, name: acme.guildName }

export const setupComingSoon = defineFixture({
  width: 1100,
  setup: () => stubDiscord('off'),
  render: () => dialog()
})

export const setupToken = defineFixture({
  width: 1100,
  setup: () => stubDiscord([]),
  render: () => dialog()
})

export const setupTokenRevoked = defineFixture({
  width: 1100,
  setup: () => stubDiscord([revoked], [inAcme]),
  render: () => dialog(inAcme, acme.guildId)
})

export const setupInvite = defineFixture({
  width: 1100,
  setup: () => stubDiscord([ready([])], [inNone]),
  render: () => dialog(inNone)
})

export const setupDone = defineFixture({
  width: 1100,
  setup: () => stubDiscord([ready([acmeNow])], [inAcme]),
  render: () => dialog(inAcme, acme.guildId)
})

export const cardServer = defineFixture({
  width: 720,
  setup: () => stubDiscord([ready([acmeNow])], [inAcme]),
  render: () => card(inAcme, acme, true)
})

export const cardNoServer = defineFixture({
  width: 720,
  setup: () => stubDiscord([ready([])], [inNone]),
  render: () => card(inNone, null)
})

export const cardTokenRevoked = defineFixture({
  width: 720,
  setup: () => stubDiscord([revoked], [inAcme]),
  render: () => card(inAcme, acme)
})
