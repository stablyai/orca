import { setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  suggestionSource,
  type BotUpNext,
  type Suggestion
} from '../../../../shared/bots/bot-look-around'
import { BotUpNextSection } from './BotUpNextSection'

const now = Date.now()

const suggestion = (id: string, title: string, why: string, link: string): Suggestion => ({
  id,
  title,
  why,
  ask: title,
  link,
  source: suggestionSource(link),
  createdAt: 1
})

const UP_NEXT: BotUpNext = {
  state: { running: false, lastLookedAt: now - 40 * 60_000, seenAt: now },
  items: [
    suggestion(
      's1',
      'Decide on stale e2e autofix PR 38365 before it rots',
      'PR 38365 has conflicted with main since Nov 2 and nobody has touched it.',
      'https://github.com/stablyai/orca/pull/38365'
    ),
    suggestion(
      's2',
      'Rescue PR 39794 (quick note on the relay retry)',
      'PR 39794 has conflicts and has not moved since last week.',
      'https://github.com/stablyai/orca/pull/39794'
    ),
    suggestion('s3', 'Triage', 'Short.', 'https://linear.app/globex/issue/ENG-1'),
    // No source: no logo, its title still on the others' edge.
    suggestion(
      's4',
      'Renew the docs domain before it lapses',
      'It expires Friday.',
      'https://example.com/dns'
    )
  ]
}

const SERVER: ExecutionHostId = 'runtime:m4'
// Listed from a paired server, as that server's listing stamps it.
const serverBot = stampBotHost(SERVER, fixtureCos)

// The bot panel's surface and padding, with its fieldset off while the bot's computer is offline;
// hover or Tab into a row to see its actions.
function Panel({
  bot = fixtureCos,
  upNext = UP_NEXT
}: {
  bot?: Bot
  upNext?: BotUpNext
}): React.JSX.Element {
  return (
    <div className="bg-sidebar px-2 py-3">
      <fieldset disabled={bot.hostId === SERVER} className="contents">
        <BotUpNextSection bot={bot} upNext={upNext} />
      </fieldset>
    </div>
  )
}

export const panel = defineFixture({ width: 340, render: () => <Panel /> })

export const narrow = defineFixture({ width: 240, render: () => <Panel /> })

export const longText = defineFixture({
  width: 220,
  render: () => (
    <Panel
      upNext={{
        ...UP_NEXT,
        items: [
          suggestion(
            'long',
            `workspace_handoff_identity_${'a'.repeat(43)}`,
            `https://example.com/${'release_checkpoint_'.repeat(10)}`,
            `https://github.com/acme/widgets/pull/${'7'.repeat(69)}`
          )
        ]
      }}
    />
  )
})

// The bot's paired server is disconnected: Start and Dismiss stay readable, off, and say why on hover.
export const offline = defineFixture({
  width: 340,
  setup: () =>
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: SERVER, state: 'offline' }
      ],
      updateNeeded: []
    }),
  render: () => <Panel bot={serverBot} />
})
