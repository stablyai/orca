import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SharedBotRequestPage } from './SharedBotRequestPage'

/** A request's page, opened from its row: who shared which agent, its purpose, Decline and Accept. */
export const page = defineFixture({
  width: 900,
  render: () => (
    <div className="relative h-[560px]">
      <SharedBotRequestPage
        request={{
          shareId: 'share-ivy',
          botId: 'ivy',
          botName: 'Ivy',
          ownerName: 'Jinwoo Hong',
          botPurpose: 'Triages flaky tests and drafts the fix'
        }}
      />
    </div>
  )
})
