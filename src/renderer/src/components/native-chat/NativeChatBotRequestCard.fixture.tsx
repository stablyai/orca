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

function Requests({ open }: { open?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-chat-pane p-4">
      {[asked, handed, notSent].map((card, index) => (
        <NativeChatBotRequestCard
          key={card.messageId ?? 'not-sent'}
          card={card}
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
