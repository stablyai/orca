import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { AgentKanbanBoard } from '../board/AgentKanbanBoard'
import { saveAgentDashboardView } from '../board/agent-dashboard-view-storage'
import { AgentFleetView } from './AgentFleetView'
import { saveFleetCollapsedProjects } from './fleet-collapsed-projects-storage'
import { buildFleetMockSnapshot, FLEET_MOCK_NOW } from './fleet-snapshot-fixtures'
import { useFleetTeamOpenOverrides } from './use-fleet-team-open-overrides'

const WIDE = 1240
const NARROW = 520
const ENGLISH = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }
const { cards, repoIconsByRepoId } = buildFleetMockSnapshot(FLEET_MOCK_NOW)

function clearStoredDashboardChoices(): void {
  saveAgentDashboardView('board')
  saveFleetCollapsedProjects(new Set())
}

function FleetFixtureView({
  fixtureCards
}: {
  fixtureCards: readonly DashboardCard[]
}): React.JSX.Element {
  const [teamOpenOverrides, onTeamOpenChange] = useFleetTeamOpenOverrides()
  return (
    <AgentFleetView
      cards={fixtureCards}
      buckets={DASHBOARD_BUCKET_ORDER}
      repoIconsByRepoId={repoIconsByRepoId}
      now={FLEET_MOCK_NOW}
      onOpenCard={() => {}}
      teamOpenOverrides={teamOpenOverrides}
      onTeamOpenChange={onTeamOpenChange}
    />
  )
}

function fleetFixture(
  width: number,
  fixtureCards: readonly DashboardCard[],
  interact?: (frame: HTMLElement) => void
) {
  return defineFixture({
    store: ENGLISH,
    setup: clearStoredDashboardChoices,
    width,
    interact,
    render: () => <FleetFixtureView fixtureCards={fixtureCards} />
  })
}

export const networkWide = fleetFixture(WIDE, cards)
export const networkNarrow = fleetFixture(NARROW, cards)
export const projectCollapsed = fleetFixture(WIDE, cards, (frame) => {
  const webAppHeader = [
    ...frame.querySelectorAll<HTMLButtonElement>('button[data-slot="collapsible-trigger"]')
  ].find((button) => button.textContent?.startsWith('web-app'))
  if (!webAppHeader) {
    throw new Error('web-app project header not found')
  }
  webAppHeader.click()
})

const [coordinator, ...others] = cards
export const wideTeam = fleetFixture(WIDE, [
  coordinator,
  ...others.slice(0, 9).map((card) => ({ ...card, parentPaneKey: coordinator.paneKey }))
])

// The board reads its own clock, so its snapshot is anchored to the real time instead.
const boardSnapshot = buildFleetMockSnapshot(Date.now())

export const boardFleetToggle = defineFixture({
  store: ENGLISH,
  setup: clearStoredDashboardChoices,
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
