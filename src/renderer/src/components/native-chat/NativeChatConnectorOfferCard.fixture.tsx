import { defineFixture } from '../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../shared/bot-types'
import type { ConnectorOffer } from '../../../../shared/bots/bot-connector-offer'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { NativeChatConnectorOfferCard } from './NativeChatConnectorOfferCard'

// A new bot with nothing connected yet, as its first-run tour finds it.
const scout: Bot = {
  id: 'bot-scout',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-scout',
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

const notAnswered = async (): Promise<{ ok: false; error: string }> => ({
  ok: false,
  error: 'fixture'
})

function stubBots(bot: Bot = scout): void {
  publishBots([bot])
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) =>
      method === 'bots.list'
        ? { ok: true, result: { bots: [bot] } }
        : { ok: false, error: { code: 'runtime_error', message: 'not in this fixture' } }
  })
  for (const source of ['botGitHub', 'botLinear', 'botSlack']) {
    Reflect.set(window.api, source, { state: notAnswered, members: notAnswered })
  }
  withBotConnectorRuntime(window.api)
}

function Offers({ sources }: { sources: ConnectorOffer['source'][] }): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div className="flex flex-col gap-3 p-4">
        {sources.map((source) => (
          <NativeChatConnectorOfferCard
            key={source}
            offer={{ botId: scout.id, source }}
            messageId={`offer-${source}`}
            fallback=""
          />
        ))}
      </div>
    </ConfirmationDialogProvider>
  )
}

export const offers = defineFixture({
  width: 640,
  setup: () => stubBots(),
  render: () => <Offers sources={['github', 'linear', 'slack']} />
})

export const offersNarrow = defineFixture({
  width: 380,
  setup: () => stubBots(),
  render: () => <Offers sources={['github', 'linear']} />
})

// The owner pressed Dismiss: Connect stays.
export const notNow = defineFixture({
  width: 640,
  setup: () => stubBots({ ...scout, offerAnswers: [{ cardId: 'offer-github', dismissed: true }] }),
  render: () => <Offers sources={['github', 'linear']} />
})

// GitHub already connected: the card still adds repositories or organizations.
export const githubConnected = defineFixture({
  width: 640,
  setup: () => stubBots({ ...scout, github: {} }),
  render: () => <Offers sources={['github']} />
})

export const githubConnectedNarrow = defineFixture({
  width: 380,
  setup: () => stubBots({ ...scout, github: {} }),
  render: () => <Offers sources={['github']} />
})

// Google: this computer already has the app and a signed-in account; Nora can also ask the bot.
const inbox: Bot = {
  ...scout,
  id: 'bot-inbox',
  name: 'Inbox helper',
  members: [{ id: 'U2', name: 'Nora', source: 'slack' }]
}
const signedIn = {
  client: { clientId: 'fixture.apps.googleusercontent.com', projectId: 'fixture' },
  accounts: [
    {
      email: 'owner@example.com',
      status: 'connected',
      connectedAt: 1,
      services: [{ service: 'gmail', state: 'ready' }]
    }
  ],
  bots: []
}

function stubGoogle(bot: Bot): void {
  let current = bot
  publishBots([current])
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) => {
      if (method === 'bots.list') {
        return { ok: true, result: { bots: [current] } }
      }
      if (method === 'google.status') {
        return { ok: true, result: signedIn }
      }
      if (method === 'google.bot.set') {
        // The owner's Turn on: the card reads the bot's new state.
        current = { ...current, google: true }
        publishBots([current])
        return { ok: true, result: { bot: { id: current.id, name: current.name, google: true } } }
      }
      return { ok: false, error: { code: 'runtime_error', message: 'not in this fixture' } }
    }
  })
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

function GoogleOffer({ bot }: { bot: Bot }): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div className="p-4">
        <NativeChatConnectorOfferCard
          offer={{ botId: bot.id, source: 'google' }}
          messageId="offer-google"
          fallback=""
        />
      </div>
    </ConfirmationDialogProvider>
  )
}

// Signed in on this computer, Google off for the bot: the card asks to connect.
export const googleOff = defineFixture({
  width: 640,
  setup: () => stubGoogle(inbox),
  render: () => <GoogleOffer bot={inbox} />
})

// One click on Connect: the Who-can-ask confirm, since Nora can ask too.
export const googleConnectConfirm = defineFixture({
  width: 640,
  setup: () => stubGoogle(inbox),
  render: () => <GoogleOffer bot={inbox} />,
  interact: () => clickWhenShown('Connect')
})

// Turn on in that confirm: the card reads Connected, with no other step.
export const googleTurnedOn = defineFixture({
  width: 640,
  setup: () => stubGoogle(inbox),
  render: () => <GoogleOffer bot={inbox} />,
  interact: async () => {
    await clickWhenShown('Connect')
    await clickWhenShown('Turn on')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
