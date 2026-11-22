import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store/index'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { resolveAutomationRunTarget } from './automation-run-open-target'
import { canRerunAutomationRun, getAutomationRunViewState } from './automation-run-view-state'
import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'
import { getAutomationRunDetailsWorkspaceName } from './automation-run-workspace-display'
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
const PAIRED_ENVIRONMENT_ID = 'sample-runtime'
const PAIRED_AUTHORITY = {
  kind: 'runtime',
  environmentId: PAIRED_ENVIRONMENT_ID,
  pairingRevision: 1
} as const

type Scenario = {
  run?: Partial<AutomationRun>
  hostLabel?: string
  workspaceCatalog?: 'removed' | 'loading'
  paired?: boolean
  isRerunPending?: boolean
}

const pairedRunTarget = (run: AutomationRun) =>
  resolveAutomationRunTarget(useAppStore.getState(), run, PAIRED_AUTHORITY)
const openPairedWorkspace = createAutomationRunWorkspaceAction({
  list: { runTargetFor: pairedRunTarget }
})

function renderRunPage(runId: string, scenario: Scenario = {}) {
  const listed = runs.find((candidate) => candidate.id === runId) ?? runs[0]
  const run = { ...listed, ...scenario.run }
  const worktree =
    run.workspaceDisplayName && !scenario.workspaceCatalog
      ? { displayName: run.workspaceDisplayName }
      : null
  const viewState = scenario.paired
    ? pairedRunTarget(run).viewState
    : getAutomationRunViewState({
        run,
        workspaceExists: worktree !== null,
        terminalTargetExists: false
      })
  const actionLabel = viewState.canOpen ? viewState.actionLabel : null
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
        workspaceName={getAutomationRunDetailsWorkspaceName({
          run,
          worktree,
          actionLabel,
          catalogHydrated: scenario.workspaceCatalog !== 'loading'
        })}
        workspaceActionLabel={actionLabel}
        canRerun={canRerunAutomationRun({ automation, run })}
        isRerunPending={scenario.isRerunPending ?? false}
        onRerun={noop}
        onOpenWorkspace={
          scenario.paired
            ? () => openPairedWorkspace(run)
            : () => console.info('[fixture] open workspace')
        }
        onReviewSetup={noop}
        onSelectRun={noop}
      />
    </div>
  )
}

const failedRun: Partial<AutomationRun> = {
  workspaceId: 'ws-1',
  workspaceDisplayName: LONG_NAME,
  status: 'dispatch_failed',
  error: 'The sample worker could not start.',
  outputSnapshot: null
}

const scenarios = {
  longName: {
    run: { workspaceId: 'ws-1', workspaceDisplayName: LONG_NAME }
  },
  longNameUsage: {
    run: {
      workspaceId: 'ws-1',
      workspaceDisplayName: LONG_NAME,
      usage: makeRunUsage({ totalTokens: 118_400, estimatedCostUsd: 0.42 })
    },
    hostLabel: 'build-box.example.net'
  },
  shortName: {
    run: {
      workspaceId: 'ws-2',
      workspaceDisplayName: 'Release notes',
      trigger: 'manual',
      usage: makeRunUsage({ totalTokens: 21_000, estimatedCostUsd: 0.08 })
    }
  },
  notLaunched: {
    run: {
      status: 'pending',
      startedAt: null,
      dispatchedAt: null,
      outputSnapshot: null
    }
  },
  removed: {
    run: { workspaceId: 'ws-3', workspaceDisplayName: 'Docs cleanup' },
    workspaceCatalog: 'removed'
  },
  rerunAvailable: { run: failedRun },
  rerunPending: {
    run: failedRun,
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
export const rerunAvailableWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.rerunAvailable)
})
export const rerunAvailableNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.rerunAvailable)
})
export const rerunPendingWide = defineFixture({
  width: 1280,
  render: () => renderRunPage('run-23', scenarios.rerunPending)
})
export const rerunPendingNarrow = defineFixture({
  width: 400,
  render: () => renderRunPage('run-23', scenarios.rerunPending)
})

const pairedRun: Scenario = {
  run: {
    workspaceId: 'sample-repo::/sample/workspace',
    terminalPaneKey: makePaneKey('sample-run', '00000000-0000-4000-8000-000000000001'),
    terminalPtyId: 'sample-pty'
  },
  hostLabel: 'preview-box.example.net',
  workspaceCatalog: 'loading',
  paired: true
}

const pairedStore = {
  runtimeEnvironments: [
    {
      id: PAIRED_ENVIRONMENT_ID,
      name: 'Preview box',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: PAIRED_ENVIRONMENT_ID,
      preferredEndpointId: 'preview',
      endpoints: []
    }
  ]
}

function setupPairedWorkspace(): void {
  window.api.runtimeEnvironments.call = async (request) => {
    console.info('[fixture] paired workspace request', JSON.stringify(request))
    return { id: 'preview', ok: true, result: null, _meta: { runtimeId: PAIRED_ENVIRONMENT_ID } }
  }
}

export const pairedWorkspaceName = defineFixture({
  width: 400,
  store: pairedStore,
  setup: setupPairedWorkspace,
  render: () =>
    renderRunPage('run-23', {
      ...pairedRun,
      run: { ...pairedRun.run, workspaceDisplayName: LONG_NAME }
    })
})

export const pairedWorkspaceUnnamed = defineFixture({
  width: 400,
  store: pairedStore,
  setup: setupPairedWorkspace,
  render: () => renderRunPage('run-23', pairedRun)
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
