import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import type { AutomationRunViewState } from './automation-run-view-state'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'
import { makeAutomation, makeRun, makeRunUsage } from '../automations-page-fixtures'

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
    createdAt: at,
    outputSnapshot: {
      format: 'plain_text',
      content: 'Checked 24 sample tasks. Two need a second pass.',
      capturedAt: at,
      truncated: false
    }
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

const LONG_NAME = 'Quartz Lab - Watch (nightly flaky-test sweep on main)'

const openable: AutomationRunViewState = {
  availability: 'workspace',
  actionLabel: 'Open workspace',
  statusLabel: 'Done',
  canOpen: true
}

type Scenario = {
  run?: Partial<AutomationRun>
  hostLabel?: string
  removedWorkspace?: boolean
  canRerun?: boolean
  isRerunPending?: boolean
}

function renderRunPage(runId: string, scenario: Scenario = {}) {
  const listed = runs.find((candidate) => candidate.id === runId) ?? runs[0]
  const run = { ...listed, ...scenario.run }
  const worktree =
    run.workspaceDisplayName && !scenario.removedWorkspace
      ? { displayName: run.workspaceDisplayName }
      : null
  const viewState = scenario.removedWorkspace
    ? { ...openable, availability: 'metadata' as const, canOpen: false }
    : worktree
      ? openable
      : null
  return (
    <div className="bg-background text-foreground">
      <AutomationRunDetailsPage
        nav={null}
        automation={automation}
        run={run}
        runs={runs}
        history={history}
        relativeNow={NOW}
        hostLabel={scenario.hostLabel ?? 'This Mac'}
        workspaceDisplay={getAutomationRunWorkspaceDisplay({ run, worktree })}
        viewState={viewState}
        canRerun={scenario.canRerun ?? false}
        isRerunPending={scenario.isRerunPending ?? false}
        onRerun={noop}
        onOpenWorkspace={() => console.info('[fixture] open workspace')}
        onReviewSetup={noop}
        onSelectRun={noop}
      />
    </div>
  )
}

const scenarios = {
  longName: {
    run: { workspaceId: 'ws-1', workspaceDisplayName: LONG_NAME },
    canRerun: true
  },
  longNameUsage: {
    run: {
      workspaceId: 'ws-1',
      workspaceDisplayName: LONG_NAME,
      usage: makeRunUsage({ totalTokens: 118_400, estimatedCostUsd: 0.42 })
    },
    hostLabel: 'build-box.example.net',
    canRerun: true
  },
  shortName: {
    run: {
      workspaceId: 'ws-2',
      workspaceDisplayName: 'Release notes',
      trigger: 'manual',
      usage: makeRunUsage({ totalTokens: 21_000, estimatedCostUsd: 0.08 })
    },
    canRerun: true
  },
  notLaunched: { canRerun: true },
  removed: {
    run: { workspaceId: 'ws-3', workspaceDisplayName: 'Docs cleanup' },
    removedWorkspace: true,
    canRerun: true
  },
  rerunPending: {
    run: { workspaceId: 'ws-1', workspaceDisplayName: LONG_NAME },
    canRerun: true,
    isRerunPending: true
  }
} satisfies Record<string, Scenario>

export const longNameWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.longName)
})
export const longNameNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.longName)
})
export const longNameUsageWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.longNameUsage)
})
export const longNameUsageNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.longNameUsage)
})
export const shortNameWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.shortName)
})
export const shortNameNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.shortName)
})
export const notLaunchedWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.notLaunched)
})
export const notLaunchedNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.notLaunched)
})
export const removedWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.removed)
})
export const removedNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.removed)
})
export const rerunPendingWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.rerunPending)
})
export const rerunPendingNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.rerunPending)
})

/** A middle run: both Older and Newer step somewhere. */
export const middle = defineFixture({ width: 1000, render: () => renderRunPage('run-23') })

/** The newest run: nothing newer. */
export const newest = defineFixture({ width: 1000, render: () => renderRunPage('run-24') })

/** The oldest run: nothing older. */
export const oldest = defineFixture({ width: 1000, render: () => renderRunPage('run-22') })

export const middleNarrow = defineFixture({ width: 360, render: () => renderRunPage('run-23') })

export const newestNarrow = defineFixture({ width: 360, render: () => renderRunPage('run-24') })

export const oldestNarrow = defineFixture({ width: 360, render: () => renderRunPage('run-22') })
