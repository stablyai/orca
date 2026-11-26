import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BotItemBody } from './BotItemView'

const verify = makeTestBotItem(19, {
  title: 'Verify the release',
  owner: { botId: 'qa', name: 'QA' },
  createdAt: Date.now() - 2 * 60 * 60_000,
  links: [
    {
      kind: 'dispatch',
      ref: 'ctx_smoke',
      latest: null,
      title: 'Run the release smoke tests',
      state: 'working',
      host: null,
      startedAt: Date.now() - 6 * 60_000,
      settledAt: null,
      report: null,
      pr: null
    },
    { kind: 'pr', ref: 'acme/app#41230', pr: null },
    {
      kind: 'item',
      ref: 'uid-4',
      item: {
        number: 4,
        owner: { botId: 'backend', name: 'Backend' },
        title: 'Release the share link API',
        status: 'done'
      }
    },
    { kind: 'item', ref: 'uid-gone', item: null }
  ]
})

// Another bot's item it follows from, as `Backend #4` beside its worker and PR; one that's gone.
export const linkedItem = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[420px] flex-col">
      <BotItemBody
        bot={fixtureCos}
        item={verify}
        view={{
          item: verify,
          events: [],
          eventsRead: true,
          hasEarlier: false,
          failed: false,
          deleted: false,
          loadEarlier: () => {},
          retry: () => {}
        }}
      />
    </div>
  )
})
