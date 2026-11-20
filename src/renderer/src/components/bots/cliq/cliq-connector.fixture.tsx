import { defineFixture } from '../../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { refreshBotCliq } from '@/lib/bot-cliq-state'
import { cancelConnectorConnect } from '@/lib/connector-connect-state'
import type { Bot, BotCliqBot } from '../../../../../shared/bot-types'
import type { ConnectorCliqState } from '../../../../../shared/connector-bot-cliq-contract'
import { BotCliqCard } from './BotCliqCard'
import { BotCliqSetupDialog } from './BotCliqSetupDialog'

type CliqOrg = ConnectorCliqState['orgs'][number]

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

const acmeLink: BotCliqBot = { orgId: '600001', orgName: 'Acme', dataCenter: 'eu' }
const acme: CliqOrg = {
  orgId: acmeLink.orgId,
  name: 'Acme',
  dataCenter: 'eu',
  userId: '700001',
  userName: 'Dana Lee'
}
const beta: CliqOrg = { ...acme, orgId: '600002', name: 'Beta Labs' }

const onCliq: Bot = {
  ...triage,
  cliqBots: [acmeLink],
  members: [
    { id: '700002', name: 'Sam Lee', source: 'cliq', workspaceId: acmeLink.orgId },
    { id: '700003', name: 'Bea Park', source: 'cliq', workspaceId: acmeLink.orgId }
  ]
}

const notAnswered = async (): Promise<{ ok: false; error: string }> => ({
  ok: false,
  error: 'fixture'
})
// A browser trip that never comes back: the fixture shows the dialog, not the browser.
const neverReturns = (): Promise<never> => new Promise(() => {})

function stubCliq(orgs: CliqOrg[] | 'off', bots: Bot[] = [triage]): void {
  publishBots(bots)
  Reflect.set(window.api, 'botCliq', {
    orgs: async () =>
      orgs === 'off' ? { ok: false, error: 'cliq_off' } : { ok: true, value: { orgs } },
    setUp: async () => ({
      ok: true,
      value: {
        state: 'installed',
        orgId: acme.orgId,
        cliqBotId: 'b-1',
        uniqueName: 'triagebot',
        installerUserId: acme.userId,
        dataCenter: 'eu',
        orgName: 'Acme'
      }
    }),
    members: notAnswered,
    connect: neverReturns,
    cancelConnect: async () => undefined,
    redeem: neverReturns
  })
  // The page stays warm between fixtures: a trip or an answer an earlier one left must not show here.
  withBotConnectorRuntime(window.api)
  cancelConnectorConnect('local', 'cliq')
  void refreshBotCliq('local')
}

async function clickWhenShown(name: string): Promise<void> {
  for (let tries = 0; tries < 50; tries++) {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name
    )
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const dialog = (bot: Bot = triage, orgId?: string): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <BotCliqSetupDialog bot={bot} orgId={orgId} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)

export const setupConnect = defineFixture({
  width: 1100,
  setup: () => stubCliq([]),
  render: () => dialog()
})

export const setupOneOrg = defineFixture({
  width: 1100,
  setup: () => stubCliq([acme]),
  render: () => dialog()
})

export const setupTwoOrgs = defineFixture({
  width: 1100,
  setup: () => stubCliq([acme, beta]),
  render: () => dialog()
})

export const setupExpired = defineFixture({
  width: 1100,
  setup: () => stubCliq([{ ...acme, expired: true }]),
  render: () => dialog()
})

export const setupDone = defineFixture({
  width: 1100,
  setup: () => stubCliq([acme]),
  render: () => dialog(),
  interact: () => clickWhenShown('Turn on Triage bot')
})

export const setupComingSoon = defineFixture({
  width: 1100,
  setup: () => stubCliq('off'),
  render: () => dialog()
})

export const card = defineFixture({
  width: 720,
  setup: () => stubCliq([acme], [onCliq]),
  render: () => (
    <ConfirmationDialogProvider>
      <BotCliqCard bot={onCliq} cliq={acmeLink} defaultOpen />
    </ConfirmationDialogProvider>
  )
})

export const cardSignInNeeded = defineFixture({
  width: 720,
  setup: () => stubCliq([{ ...acme, expired: true }], [onCliq]),
  render: () => (
    <ConfirmationDialogProvider>
      <BotCliqCard bot={onCliq} cliq={acmeLink} />
    </ConfirmationDialogProvider>
  )
})
