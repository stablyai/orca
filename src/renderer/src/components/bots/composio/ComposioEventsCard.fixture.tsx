import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import { ComposioEventsCardView, type ComposioEventsView } from './ComposioEventsCard'
import { ComposioEventsByHandStepsView } from './ComposioEventsByHandSteps'

const steps = (
  <ComposioEventsByHandStepsView
    botName="Atlas"
    triggerName="New Outlook Message"
    copyUrl={
      <Button size="xs" variant="outline">
        Copy URL
      </Button>
    }
    busy={false}
    onDone={() => {}}
  />
)

function card(view: ComposioEventsView, extra: { byHand?: boolean; error?: string } = {}) {
  return (
    <ComposioEventsCardView
      botName="Atlas"
      triggerName="New Outlook Message"
      view={view}
      busy={false}
      error={extra.error ?? null}
      byHandSteps={extra.byHand ? steps : null}
      onSetUp={() => {}}
      onByHand={() => {}}
      onUndoByHand={() => {}}
    />
  )
}

export const oneClick = defineFixture({
  width: 720,
  render: () => card({ status: 'ready', target: 'none', on: false })
})
export const replaceAsks = defineFixture({
  width: 720,
  render: () => card({ status: 'ready', target: 'other', on: false })
})
export const done = defineFixture({
  width: 720,
  render: () => card({ status: 'ready', target: 'ours', on: true })
})
export const byHand = defineFixture({
  width: 720,
  render: () => card({ status: 'ready', target: 'none', on: false }, { byHand: true })
})
export const failed = defineFixture({
  width: 720,
  render: () =>
    card(
      { status: 'ready', target: 'none', on: false },
      { error: 'Composio: no connected account found for outlook.' }
    )
})
