import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import {
  type SalvageOffered,
  salvageProposalText
} from '../../../../../shared/bots/bot-memory-salvage-text'
import { BotItemBody } from './BotItemView'

// Salvage's proposal as the owner sees it: Orca's item listing journal lines that read like the
// owner's decisions, word for word, with Keep all and Keep none. Synthetic lines only.
const SAMPLE = [
  {
    line: "- 2026-11-03 Item 600 (export menu) PR #5900 merged; Dana picked: 'CSV first' after round C2",
    month: '2026-11',
    replacedBy: null
  },
  {
    line: '- 2026-11-04 owner decided the card layout uses tabs, #5902 merged',
    month: '2026-11',
    replacedBy: '- 2026-11-15 #5902 reverted, the card layout uses a single list instead'
  },
  {
    line: "- 2026-11-06 Dana: 'copy logs button' on the crash dialog, PR #5906 round C2",
    month: '2026-11',
    replacedBy: null
  }
]
const TWENTY = Array.from({ length: 20 }, (_, index) => ({
  line: `- 2026-10-${String(index + 1).padStart(2, '0')} Dana picked option ${index + 1} for the settings page, PR #${6100 + index} merged`,
  month: '2026-10',
  replacedBy: null
}))
const orca = { kind: 'orca' as const, why: 'salvage' }
const at = Date.now() - 3_600_000

function viewOf(offered: SalvageOffered[]) {
  const proposal = salvageProposalText(offered)
  const asked = makeTestBotItem(700, {
    title: proposal.title,
    owner: { botId: fixtureCos.id, name: 'Scout' },
    status: 'needs_you',
    createdAt: at,
    question: {
      eventId: 'e71',
      text: 'readable copy',
      gist: proposal.ask.context ?? '',
      decisions: proposal.ask.questions.map((question) => ({
        question: question.prompt,
        replies: question.options.map(({ label }, index) => ({
          label,
          recommended: question.recommended === index
        }))
      }))
    }
  })
  return {
    item: asked,
    events: [
      { id: 'e70', kind: 'made' as const, actor: orca, data: {}, at },
      {
        id: 'e71',
        kind: 'commented' as const,
        actor: orca,
        data: { text: 'readable copy', ask: proposal.ask },
        at
      },
      {
        id: 'e72',
        kind: 'status' as const,
        actor: orca,
        data: { from: 'planned', to: 'needs_you' },
        at
      }
    ],
    eventsRead: true,
    hasEarlier: false,
    failed: false,
    deleted: false,
    loadEarlier: () => {},
    retry: () => {}
  }
}

function Proposal({
  offered,
  height
}: {
  offered: SalvageOffered[]
  height: number
}): React.JSX.Element {
  const view = viewOf(offered)
  return (
    <div className="flex flex-col bg-sidebar" style={{ height }}>
      <BotItemBody bot={{ ...fixtureCos, name: 'Scout' }} item={view.item} view={view} />
    </div>
  )
}

/** Three lines, the second possibly replaced later. */
export const proposalNarrow = defineFixture({
  width: 360,
  render: () => <Proposal offered={SAMPLE} height={760} />
})

export const proposalWide = defineFixture({
  width: 640,
  render: () => <Proposal offered={SAMPLE} height={760} />
})

/** A full proposal: 20 lines, none replaced. */
export const proposalTwenty = defineFixture({
  width: 360,
  render: () => <Proposal offered={TWENTY} height={2200} />
})
