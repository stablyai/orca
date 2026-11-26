import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { EMPTY_DASHBOARD_SNAPSHOT } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BotAvatar } from '../../bots/BotAvatar'
import { DashboardBotAskCard, toDashboardBotAsk } from '../bot-asks/DashboardBotAsks'
import { AgentKanbanBoard } from './AgentKanbanBoard'

const now = Date.now()
const item = makeTestBotItem(42, {
  title: 'Pick the release headline',
  status: 'needs_you',
  question: { eventId: 'e9', text: 'Lead with the dashboard change or the bot changes?' },
  lastActivityAt: now - 12 * 60_000
})

export const withoutBotItems = defineFixture({
  width: 1100,
  render: () => <AgentKanbanBoard snapshot={EMPTY_DASHBOARD_SNAPSHOT} containerClassName="h-80" />
})

export const withBotItem = defineFixture({
  width: 1100,
  render: () => (
    <AgentKanbanBoard
      snapshot={EMPTY_DASHBOARD_SNAPSHOT}
      containerClassName="h-80"
      needsYouExtra={{
        count: 1,
        content: (
          <DashboardBotAskCard
            ask={toDashboardBotAsk(fixtureCos, item, now)}
            avatar={<BotAvatar bot={fixtureCos} className="size-3.5 rounded-full text-[8px]" />}
            now={now}
            onOpen={() => {}}
          />
        )
      }}
    />
  )
})
