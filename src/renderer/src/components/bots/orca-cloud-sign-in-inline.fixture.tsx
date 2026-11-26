// Each inline place a bot asks for Orca sign-in, signed out and once Sign in carried it on.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import type { ConnectorOffer } from '../../../../shared/bots/bot-connector-offer'
import { NativeChatConnectorOfferCard } from '../native-chat/NativeChatConnectorOfferCard'
import { NativeChatBotKickoffContext } from '../native-chat/native-chat-bot-kickoff-view'
import { chatTakingSends } from './orca-sign-in.test-fixture'
import { BotConnectorsSection } from '../settings/bots/BotConnectorsSection'
import { refreshBotCloudReads } from './BotCloudSignInNotice'
import { BotSlackCard } from './slack/BotSlackCard'
import {
  click,
  connected,
  inSlack,
  settle,
  signIn,
  signedOut,
  signedOutStore,
  stablyInstalled,
  stubCloud
} from './orca-cloud-sign-in-host-fixture'

const Panel = ({ open = false }: { open?: boolean }): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <TooltipProvider>
      <div className="flex flex-col gap-3 bg-sidebar px-2 py-3 text-sidebar-foreground">
        <BotConnectorsSection bot={inSlack} />
        {open ? <BotSlackCard bot={inSlack} teamId="T1" defaultOpen /> : null}
      </div>
    </TooltipProvider>
  </ConfirmationDialogProvider>
)
/** Signed out mid-session: what was set up reads as paused, once, with the reason on top. */
async function signOut(): Promise<void> {
  await settle(600)
  useAppStore.setState({ orcaProfileAuthStatus: signedOut })
  await refreshBotCloudReads(inSlack)
  emitBotsChangedWindowEvent('local')
  await settle(900)
}
const signedInThenOut: Partial<AppState> = { ...signedOutStore(), orcaProfileAuthStatus: connected }

/** The Connectors tab: one quiet line, and each cloud row reads Needs sign-in. */
export const connectorsSignedOut = defineFixture({
  width: 380,
  store: signedInThenOut,
  setup: () => stubCloud(stablyInstalled),
  render: () => <Panel />,
  interact: signOut
})
export const connectorsResumed = defineFixture({
  width: 380,
  store: signedInThenOut,
  setup: () => stubCloud(stablyInstalled),
  render: () => <Panel />,
  interact: async () => {
    await signOut()
    await signIn()
  }
})

/** Slack › Who can ask: why no access requests show, with Sign in on the row. */
export const whoCanAskSignedOut = defineFixture({
  width: 380,
  store: signedOutStore(),
  setup: () => stubCloud(stablyInstalled),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="bg-sidebar px-2 py-3 text-sidebar-foreground">
        <BotSlackCard bot={inSlack} teamId="T1" defaultOpen />
      </div>
    </ConfirmationDialogProvider>
  )
})
export const whoCanAskResumed = defineFixture({
  width: 380,
  store: signedOutStore(),
  setup: () => stubCloud(stablyInstalled),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="bg-sidebar px-2 py-3 text-sidebar-foreground">
        <BotSlackCard bot={inSlack} teamId="T1" defaultOpen />
      </div>
    </ConfirmationDialogProvider>
  ),
  interact: async () => {
    await click('Sign in')
    await settle(1500)
  }
})

const chat = chatTakingSends(async () => true)

function ChatLine({ offer }: { offer: ConnectorOffer }): React.JSX.Element {
  return (
    <NativeChatBotKickoffContext.Provider value={chat}>
      <div className="flex flex-col gap-2 p-4 text-sm">
        <p className="self-end rounded-lg bg-muted px-3 py-2">
          {offer.source === 'webhook'
            ? 'Make me a webhook Sentry can call when an issue spikes.'
            : 'When someone posts in #deploys, summarize what shipped and reply in the thread.'}
        </p>
        <NativeChatConnectorOfferCard offer={offer} messageId={`m-${offer.source}`} fallback="" />
      </div>
    </NativeChatBotKickoffContext.Provider>
  )
}
/** Sign in from the chat; the host keeps the card's answer and says the bot changed. */
async function answeredInChat(): Promise<void> {
  await signIn()
  emitBotsChangedWindowEvent('local')
  await settle(600)
}
const setUpChat = (): void => {
  stubCloud(stablyInstalled)
}

/** The bot asked for a Slack event rule: one line with Sign in, before anything is saved. */
export const eventRuleSignedOut = defineFixture({
  width: 640,
  store: signedOutStore(),
  setup: setUpChat,
  render: () => <ChatLine offer={{ botId: inSlack.id, source: 'slack', signIn: true }} />
})
/** Signed in from the chat: the bot is told, and saves the rule. */
export const eventRuleResumed = defineFixture({
  width: 640,
  store: signedOutStore(),
  setup: setUpChat,
  render: () => <ChatLine offer={{ botId: inSlack.id, source: 'slack', signIn: true }} />,
  interact: answeredInChat
})
export const webhookSignedOut = defineFixture({
  width: 640,
  store: signedOutStore(),
  setup: setUpChat,
  render: () => <ChatLine offer={{ botId: inSlack.id, source: 'webhook', signIn: true }} />
})
export const webhookResumed = defineFixture({
  width: 640,
  store: signedOutStore(),
  setup: setUpChat,
  render: () => <ChatLine offer={{ botId: inSlack.id, source: 'webhook', signIn: true }} />,
  interact: answeredInChat
})
