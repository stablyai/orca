import type { JSX } from 'react'
import { FEATURE_TIPS } from '../../../../shared/feature-education/feature-tips'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { BotsTeammateTipDialog } from './BotsTeammateTipDialog'
import { BotsTipGroupVisual } from './BotsTipGroupVisual'
import { BotsTipItemsVisual } from './BotsTipItemsVisual'
import { BotsTipSlackVisual } from './BotsTipSlackVisual'
import { BOTS_TIP_PAGE_END } from './bots-tip-timeline'
import './bots-tip.css'

const tip = FEATURE_TIPS.find((item) => item.id === 'bots-teammate')
if (!tip) {
  throw new Error('Bots feature tip is missing')
}

// The card as it opens: page 1 playing, then every page in turn.
export const card = defineFixture({
  render: () => (
    <BotsTeammateTipDialog open tip={tip} onOpenChange={() => {}} onPrimaryAction={() => {}} />
  )
})

function frozen(visual: JSX.Element): JSX.Element {
  return (
    <div data-feature-tip="bots" className="relative h-[30.5rem] w-[33rem] bg-muted/60">
      {visual}
    </div>
  )
}

// Page 1's last frame: the pull request has landed in the thread.
export const slackEnd = defineFixture({
  render: () => frozen(<BotsTipSlackVisual t={BOTS_TIP_PAGE_END[0]} />)
})

// Page 2 with the item view open on the question, the answer half typed.
export const itemsAnswering = defineFixture({
  render: () => frozen(<BotsTipItemsVisual t={12.2} />)
})

// Page 2's last frame: every item closed.
export const itemsEnd = defineFixture({
  render: () => frozen(<BotsTipItemsVisual t={BOTS_TIP_PAGE_END[1]} />)
})

// Page 3's last frame: the release bot's answer with the pull request.
export const groupEnd = defineFixture({
  render: () => frozen(<BotsTipGroupVisual t={BOTS_TIP_PAGE_END[2]} />)
})
