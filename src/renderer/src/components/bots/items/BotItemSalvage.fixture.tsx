import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { salvageProposalText } from '../../../../../shared/bots/bot-memory-salvage-text'
import { BotItemBody } from './BotItemView'

// Salvage's proposal as the owner sees it: Orca's item listing journal lines that read like the
// owner's decisions, word for word, with Keep all and Keep none. Synthetic lines only.
const proposal = salvageProposalText([
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
])
const orca = { kind: 'orca' as const, why: 'salvage' }
const asked = makeTestBotItem(700, {
  title: proposal.title,
  description: proposal.description,
  owner: { botId: fixtureCos.id, name: 'Scout' },
  status: 'needs_you',
  question: {
    eventId: 'e71',
    text: 'readable copy',
    gist: proposal.ask.context ?? '',
    decisions: proposal.ask.questions.map((question) => ({
      question: question.prompt,
      replies: question.options.map(({ label }) => ({ label, recommended: false }))
    }))
  }
})
const view = {
  item: asked,
  events: [
    { id: 'e70', kind: 'made' as const, actor: orca, data: {}, at: Date.now() - 3_600_000 },
    {
      id: 'e71',
      kind: 'commented' as const,
      actor: orca,
      data: { text: 'readable copy', ask: proposal.ask },
      at: Date.now() - 3_600_000
    },
    {
      id: 'e72',
      kind: 'status' as const,
      actor: orca,
      data: { from: 'planned', to: 'needs_you' },
      at: Date.now() - 3_600_000
    }
  ],
  eventsRead: true,
  hasEarlier: false,
  failed: false,
  deleted: false,
  loadEarlier: () => {},
  retry: () => {}
}

function Proposal({ height }: { height: number }): React.JSX.Element {
  return (
    <div className="flex flex-col bg-sidebar" style={{ height }}>
      <BotItemBody bot={{ ...fixtureCos, name: 'Scout' }} item={asked} view={view} />
    </div>
  )
}

export const proposalNarrow = defineFixture({
  width: 360,
  render: () => <Proposal height={720} />
})

export const proposalWide = defineFixture({
  width: 640,
  render: () => <Proposal height={720} />
})
