import { defineFixture } from '../../../component-fixtures/component-fixture'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { makeAutomation } from '../automations-page-fixtures'
import { AutomationDetailHealth } from './AutomationDetailHealth'

const NOW = Date.UTC(2026, 10, 27, 6, 10)
const HOUR = 60 * 60 * 1000

function renderHealth(overrides: Parameters<typeof makeAutomation>[0]) {
  return (
    <div className="bg-background p-4 text-foreground">
      <AutomationDetailHealth
        automation={makeAutomation(overrides)}
        runs={[]}
        latestRun={undefined}
        now={NOW}
      />
    </div>
  )
}

export const overdue = defineFixture({
  width: 720,
  render: () => renderHealth({ nextRunAt: NOW - 20 * HOUR })
})

export const upcoming = defineFixture({
  width: 720,
  render: () => renderHealth({ nextRunAt: NOW + HOUR })
})

export const paused = defineFixture({
  width: 720,
  render: () => renderHealth({ enabled: false, nextRunAt: NOW - 20 * HOUR })
})

export const eventsOnly = defineFixture({
  width: 720,
  render: () => renderHealth({ ...EVENT_ONLY_SCHEDULE, nextRunAt: 0 })
})
