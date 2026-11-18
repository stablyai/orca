import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { AgentKanbanBoard } from '../board/AgentKanbanBoard'
import { AgentFleetView, type AgentFleetLayout } from './AgentFleetView'
import { buildFleetMockSnapshot, FLEET_MOCK_NOW } from './fleet-mock-snapshot'

const WIDE = 1240
const NARROW = 520
const ENGLISH = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }
const snapshot = buildFleetMockSnapshot(FLEET_MOCK_NOW)

function fleetFixture(layout: AgentFleetLayout, width: number) {
  return defineFixture({
    store: ENGLISH,
    width,
    render: () => <AgentFleetView snapshot={snapshot} now={FLEET_MOCK_NOW} layout={layout} />
  })
}

export const networkWide = fleetFixture('network', WIDE)
export const networkNarrow = fleetFixture('network', NARROW)
export const timelineWide = fleetFixture('timeline', WIDE)
export const timelineNarrow = fleetFixture('timeline', NARROW)

// The board reads its own clock, so its snapshot is anchored to the real time instead.
const boardSnapshot = buildFleetMockSnapshot(Date.now())

export const boardBefore = defineFixture({
  store: ENGLISH,
  width: WIDE,
  render: () => <AgentKanbanBoard snapshot={boardSnapshot} containerClassName="h-[760px] w-full" />
})
