import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { AgentKanbanBoard } from '../board/AgentKanbanBoard'
import { AgentFleetView } from './AgentFleetView'
import { buildFleetMockSnapshot, FLEET_MOCK_NOW } from './fleet-mock-snapshot'

const WIDE = 1240
const NARROW = 520
const ENGLISH = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }
const { cards } = buildFleetMockSnapshot(FLEET_MOCK_NOW)

function fleetFixture(width: number, fixtureCards: readonly DashboardCard[]) {
  return defineFixture({
    store: ENGLISH,
    width,
    render: () => (
      <AgentFleetView
        cards={fixtureCards}
        buckets={DASHBOARD_BUCKET_ORDER}
        now={FLEET_MOCK_NOW}
        onOpenCard={() => {}}
      />
    )
  })
}

export const networkWide = fleetFixture(WIDE, cards)
export const networkNarrow = fleetFixture(NARROW, cards)

const [coordinator, ...others] = cards
export const wideTeam = fleetFixture(WIDE, [
  coordinator,
  ...others.slice(0, 9).map((card) => ({ ...card, parentPaneKey: coordinator.paneKey }))
])

// The board reads its own clock, so its snapshot is anchored to the real time instead.
const boardSnapshot = buildFleetMockSnapshot(Date.now())

export const boardFleetToggle = defineFixture({
  store: ENGLISH,
  width: WIDE,
  render: () => <AgentKanbanBoard snapshot={boardSnapshot} containerClassName="h-[760px] w-full" />,
  interact: (frame) => {
    const fleetToggle = [...frame.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
      (button) => button.textContent === 'Fleet'
    )
    if (!fleetToggle) {
      throw new Error('Fleet toggle not found')
    }
    fleetToggle.click()
  }
})
