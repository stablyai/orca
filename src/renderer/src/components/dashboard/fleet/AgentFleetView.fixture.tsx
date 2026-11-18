import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { DASHBOARD_BUCKET_ORDER } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { AgentFleetView } from './AgentFleetView'
import { buildFleetMockSnapshot, FLEET_MOCK_NOW } from './fleet-mock-snapshot'

const WIDE = 1240
const NARROW = 520
const ENGLISH = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }
const { cards } = buildFleetMockSnapshot(FLEET_MOCK_NOW)

function fleetFixture(width: number) {
  return defineFixture({
    store: ENGLISH,
    width,
    render: () => (
      <AgentFleetView
        cards={cards}
        buckets={DASHBOARD_BUCKET_ORDER}
        now={FLEET_MOCK_NOW}
        onOpenCard={() => {}}
      />
    )
  })
}

export const networkWide = fleetFixture(WIDE)
export const networkNarrow = fleetFixture(NARROW)
