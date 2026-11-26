import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import {
  botItemAskText,
  botItemQuestionShape,
  type BotItemAsk
} from '../../../../../shared/bots/bot-item-ask'
import { RECOMMENDED_ASKS } from '../../../../../shared/bots/bot-item-ask-recommended.test-fixture'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemQuestionLines } from './BotItemQuestionLines'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'

const NOW = 1_800_000_000_000

/** The waiting ask as an item's view wires it: the stored ask's event, the item's quick replies and
 *  stepped card from the real hook, and every comment they send listed under it (`data-sent`), so a
 *  browser check can read what a click or key posted. */
function WaitingAsk({ ask }: { ask: BotItemAsk }): React.JSX.Element {
  const text = botItemAskText(ask)
  const event: BotItemEvent = {
    id: 'e2',
    kind: 'commented',
    actor: { kind: 'bot', botId: fixtureCos.id, chatId: 'chat-home' },
    data: { text, ask },
    at: NOW
  }
  const item = makeTestBotItem(7, {
    owner: { botId: fixtureCos.id, name: fixtureCos.name },
    status: 'needs_you',
    question: { eventId: 'e2', text }
  })
  const [posted, setPosted] = useState<{ id: number; json: string }[]>([])
  const { steps, sent, quick } = useBotItemQuestionSteps(
    fixtureCos,
    item,
    [event],
    (words, _paths, questionId, _plain, _skills, skipped) =>
      setPosted((list) => [
        ...list,
        { id: list.length + 1, json: JSON.stringify({ text: words, questionId, skipped }) }
      ]),
    []
  )
  return (
    <div className="bg-card px-4 py-3">
      <BotItemQuestionLines
        shape={botItemQuestionShape(event.data)}
        askId="e2"
        waiting
        actions={{ send: quick, edit: () => {}, restore: () => false, type: () => {}, steps, sent }}
      />
      <ol data-sent hidden>
        {posted.map((entry) => (
          <li key={entry.id}>{entry.json}</li>
        ))}
      </ol>
    </div>
  )
}

export const written = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.written.stored} />
})
export const flagged = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.flagged.stored} />
})
export const twin = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.twin.stored} />
})
export const joined = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.joined.stored} />
})
export const several = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.several.stored} />
})
export const delimited = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.delimited.stored} />
})
export const attached = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.attached.stored} />
})
export const twinFlagged = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.twinFlagged.stored} />
})
export const bracketAttached = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.bracketAttached.stored} />
})
export const commaWait = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.commaWait.stored} />
})
export const multiline = defineFixture({
  width: 360,
  render: () => <WaitingAsk ask={RECOMMENDED_ASKS.multiline.stored} />
})
