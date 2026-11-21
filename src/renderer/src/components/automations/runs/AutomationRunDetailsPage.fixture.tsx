import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'
import { makeAutomation, makeRun } from '../automations-page-fixtures'

const NOW = Date.UTC(2026, 10, 20, 19, 0)
const HOUR = 60 * 60 * 1000

const automation = makeAutomation({ name: 'Nightly triage', agentId: 'codex' })

// Newest first, as the page receives them.
const runs = [24, 23, 22].map((runNumber, index) => {
  const at = NOW - (10 + index * 24) * HOUR
  return makeRun({
    id: `run-${runNumber}`,
    runNumber,
    scheduledFor: at,
    startedAt: at,
    dispatchedAt: at,
    createdAt: at
  })
})

const history: SelectedAutomationRunHistoryOutcome = {
  automationId: automation.id,
  rowKey: null,
  ownerKey: null,
  authority: null,
  navigation: null,
  reloadToken: 0,
  runs,
  notice: null
}

const noop = (): void => {}

function renderRunPage(runId: string) {
  const run = runs.find((candidate) => candidate.id === runId) ?? runs[0]
  return (
    <div className="bg-background text-foreground">
      <AutomationRunDetailsPage
        nav={null}
        automation={automation}
        run={run}
        runs={runs}
        history={history}
        relativeNow={NOW}
        hostLabel="This Mac"
        workspaceDisplay={null}
        viewState={{
          availability: 'workspace',
          actionLabel: 'Open workspace',
          statusLabel: 'Done',
          canOpen: true
        }}
        canRerun={false}
        isRerunPending={false}
        onRerun={noop}
        onOpenWorkspace={noop}
        onReviewSetup={noop}
        onSelectRun={noop}
      />
    </div>
  )
}

/** A middle run: both Older and Newer step somewhere. */
export const middle = defineFixture({ width: 1000, render: () => renderRunPage('run-23') })

/** The newest run: nothing newer. */
export const newest = defineFixture({ width: 1000, render: () => renderRunPage('run-24') })

/** The oldest run: nothing older. */
export const oldest = defineFixture({ width: 1000, render: () => renderRunPage('run-22') })

export const middleNarrow = defineFixture({ width: 360, render: () => renderRunPage('run-23') })

export const newestNarrow = defineFixture({ width: 360, render: () => renderRunPage('run-24') })

export const oldestNarrow = defineFixture({ width: 360, render: () => renderRunPage('run-22') })
