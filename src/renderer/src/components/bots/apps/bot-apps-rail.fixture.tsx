import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BotAppsView } from './BotAppsRail'
import { BotAppsRail } from './BotAppsRail'

const rail = (name: string, view: BotAppsView) => (
  <div className="h-80">
    <BotAppsRail
      bot={{ id: 'bot-builder', hostId: 'local', name, avatar: null }}
      view={view}
      onView={() => {}}
      mineCount={1}
      categories={[
        { category: 'chat', count: 1 },
        { category: 'docs', count: 12 }
      ]}
      composio
      onAddByUrl={() => {}}
      onWebhooks={() => {}}
    />
  </div>
)

// A bot name too long for the rail: one line each, ending in an ellipsis, counts in place.
export const longBotName = defineFixture({
  width: 240,
  render: () => rail('Orchestration builder for the whole team', 'mine')
})

// All apps selected; hover On <bot> to compare hover with selected.
export const allSelected = defineFixture({
  width: 240,
  render: () => rail('Bot builder', 'all')
})
