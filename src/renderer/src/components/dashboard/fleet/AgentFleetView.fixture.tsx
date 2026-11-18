import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { AgentFleetView } from './AgentFleetView'
import { buildFleetMockSnapshot, FLEET_MOCK_NOW } from './fleet-mock-snapshot'

const WIDE = 1240
const NARROW = 520
const ENGLISH = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }
const snapshot = buildFleetMockSnapshot(FLEET_MOCK_NOW)

function fleetFixture(width: number) {
  return defineFixture({
    store: ENGLISH,
    width,
    render: () => <AgentFleetView snapshot={snapshot} now={FLEET_MOCK_NOW} />
  })
}

export const networkWide = fleetFixture(WIDE)
export const networkNarrow = fleetFixture(NARROW)
