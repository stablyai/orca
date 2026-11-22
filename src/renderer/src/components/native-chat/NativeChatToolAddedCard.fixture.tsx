import { defineFixture } from '../../component-fixtures/component-fixture'
import type { BotOwnTool } from '../../../../shared/bot-tools'
import { NativeChatToolAddedCard } from './NativeChatToolAddedCard'
import {
  FIXTURE_AT,
  fixtureParam,
  fixtureTeammate,
  installFixtureTeammates
} from './native-chat-timeline-fixture-data'

const kept = fixtureTeammate('tools-kept', 'Release helper')
const cleared = fixtureTeammate('tools-cleared', 'Release helper')
const metrics: BotOwnTool = {
  name: 'metrics',
  detail: 'node ~/tools/metrics-mcp/index.js',
  remote: false
}

function setup(): void {
  installFixtureTeammates([kept, cleared], {
    'bots.tools.list': (params) => ({
      agent: 'claude',
      own: fixtureParam(params, 'botId') === kept.id ? [metrics] : [],
      inherited: []
    }),
    'bots.tools.problems': () => ({ problems: {} })
  })
}

function Tools(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-chat-pane p-4">
      {[kept, cleared].map((owner) => (
        <NativeChatToolAddedCard
          key={owner.id}
          added={{ botId: owner.id, tool: metrics, addedAt: FIXTURE_AT }}
          timestamp={FIXTURE_AT}
        />
      ))}
    </div>
  )
}

export const added = defineFixture({ width: 600, setup, render: () => <Tools /> })

export const addedNarrow = defineFixture({ width: 340, setup, render: () => <Tools /> })

/** Keyboard focus on the row shows its action and time, as hover does. */
export const addedFocused = defineFixture({
  width: 600,
  setup,
  render: () => <Tools />,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    frame.querySelector<HTMLButtonElement>('button')?.focus({ focusVisible: true })
  }
})
