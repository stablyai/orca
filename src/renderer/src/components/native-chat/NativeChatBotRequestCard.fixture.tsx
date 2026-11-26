import { nativeChatAppearanceStyle } from './appearance/native-chat-appearance-style'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { BotRequestCard } from '../../../../shared/bots/bot-request-card'
import { NativeChatBotRequestCard } from './NativeChatBotRequestCard'
import {
  FIXTURE_AT,
  fixtureParam,
  fixtureTeammate,
  installFixtureTeammates
} from './native-chat-timeline-fixture-data'

const design = fixtureTeammate('design', 'Design')
const release = fixtureTeammate('release', 'Release helper')

const asked: BotRequestCard = {
  toBotId: design.id,
  toBotName: design.name,
  purpose: 'question',
  subject: 'Tone for the empty state',
  messageId: 'mail-asked'
}
const handed: BotRequestCard = {
  toBotId: release.id,
  toBotName: release.name,
  purpose: 'handoff',
  subject: 'Cut the 1.4.233 release notes from the merged pull requests',
  messageId: 'mail-handed'
}
const notSent: BotRequestCard = {
  toBotId: design.id,
  toBotName: design.name,
  purpose: 'question',
  subject: 'Tone for the empty state',
  refusal: 'bot_paused'
}

function setup(): void {
  installFixtureTeammates([design, release], {
    'bots.request.outcome': (params) =>
      fixtureParam(params, 'messageId') === 'mail-asked'
        ? {
            outcome: 'answered',
            answer: 'Keep it plain and short; no exclamation marks.',
            mailIds: []
          }
        : { outcome: null, answer: null, mailIds: [] }
  })
}

function Requests({
  open,
  messaging = false
}: {
  open?: boolean
  messaging?: boolean
}): React.JSX.Element {
  return (
    <div
      className={
        messaging
          ? 'native-chat-appearance flex flex-col gap-3 bg-chat-pane p-4'
          : 'flex flex-col gap-1 bg-chat-pane p-4'
      }
      style={
        messaging
          ? nativeChatAppearanceStyle({
              theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
            })
          : undefined
      }
    >
      {[asked, handed, notSent].map((card, index) => (
        <NativeChatBotRequestCard
          key={card.messageId ?? 'not-sent'}
          card={card}
          messaging={messaging}
          cardId={`${open ? 'open' : 'closed'}-${index}`}
          timestamp={FIXTURE_AT + index * 60_000}
          fallback={card.subject}
        />
      ))}
    </div>
  )
}

const openAll = async (frame: HTMLElement): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const button of frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')) {
    button.click()
  }
}

export const requests = defineFixture({ width: 600, setup, render: () => <Requests /> })

export const requestsOpen = defineFixture({
  width: 600,
  setup,
  render: () => <Requests open />,
  interact: openAll
})

export const requestsNarrow = defineFixture({ width: 340, setup, render: () => <Requests /> })

// Asks to an agent on a paired computer: one named, one whose name never reached this host.
const pairedNamed: BotRequestCard = {
  ...asked,
  messageId: 'mail-paired-named',
  client: { installationId: 'inst-studio', computer: 'Studio Mac' }
}
const pairedUnnamed: BotRequestCard = {
  ...asked,
  messageId: 'mail-paired-unnamed',
  client: { installationId: 'inst-unnamed', computer: '' }
}

export const pairedComputerAsks = defineFixture({
  width: 600,
  setup,
  render: () => (
    <div className="flex flex-col gap-1 bg-chat-pane p-4">
      {[pairedNamed, pairedUnnamed].map((card, index) => (
        <NativeChatBotRequestCard
          key={card.messageId}
          card={card}
          cardId={`paired-${index}`}
          timestamp={FIXTURE_AT + index * 60_000}
          fallback={card.subject}
        />
      ))}
    </div>
  )
})

export const messagingNotes = defineFixture({
  width: 640,
  setup,
  render: () => <Requests messaging />
})
export const messagingNotesOpen = defineFixture({
  width: 640,
  setup,
  render: () => <Requests messaging open />,
  interact: openAll
})
