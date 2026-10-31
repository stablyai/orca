import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import type { AutomationRunOutputActions } from './AutomationRunResults'

const REPORT_HTML = `<!doctype html><html><head><style>
body{font-family:system-ui;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}
p{color:#555;margin:0 0 16px}table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
</style></head><body><h1>Weekly brief</h1><p>GitHub activity for Oct 23 to Oct 30. Linear issues were not included.</p>
<table><tr><th>Area</th><th>Merged</th><th>Open</th></tr><tr><td>Terminal</td><td>12</td><td>4</td></tr>
<tr><td>Automations</td><td>5</td><td>2</td></tr><tr><td>Mobile</td><td>3</td><td>6</td></tr></table></body></html>`

const baseRun: AutomationRun = {
  id: 'run-7',
  automationId: 'automation-1',
  title: 'Weekly brief run 7',
  scheduledFor: Date.UTC(2026, 9, 30, 13, 0),
  status: 'completed',
  trigger: 'scheduled',
  workspaceId: 'wt-1',
  workspaceDisplayName: 'main',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: {
    format: 'plain_text',
    content: 'Brief generated from GitHub. Linear returned 403, so its issues are not included.',
    capturedAt: 1,
    truncated: false
  },
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: 1,
  dispatchedAt: 1,
  createdAt: 1,
  resultReporting: 'offered'
}

const warnedRun: AutomationRun = {
  ...baseRun,
  warnings: [
    {
      key: 'linear',
      message: 'Linear issues were not included.',
      impact: 'The brief covers GitHub activity only.',
      evidence: 'GET https://api.linear.app/graphql\n403 Forbidden: workspace access revoked',
      firstReportedAt: 1,
      lastReportedAt: 2,
      reportCount: 2,
      resolvedAt: null,
      resolution: null
    },
    {
      key: 'ci',
      message: 'CI status could not be loaded on the first try.',
      impact: null,
      evidence: null,
      firstReportedAt: 1,
      lastReportedAt: 1,
      reportCount: 1,
      resolvedAt: 3,
      resolution: 'Loaded on retry.'
    }
  ],
  outputs: [
    {
      id: 'o1',
      title: 'Weekly brief',
      format: 'html',
      bytes: REPORT_HTML.length,
      attachedAt: 2
    },
    {
      id: 'o2',
      title: 'Raw notes',
      format: 'markdown',
      bytes: 2_310,
      attachedAt: 2
    }
  ]
}

const actions: AutomationRunOutputActions = {
  load: async (outputId) =>
    outputId === 'o1' ? REPORT_HTML : '## Notes\n\n- 20 PRs merged\n- 12 issues open',
  open: async () => {},
  download: async () => {}
}

function Page({
  run,
  outputActions = actions
}: {
  run: AutomationRun
  outputActions?: AutomationRunOutputActions
}): React.JSX.Element {
  return (
    <AutomationRunDetailsPage
      automation={null}
      run={run}
      relativeNow={Date.UTC(2026, 9, 30, 14, 0)}
      workspaceDisplay={null}
      viewState={null}
      canRerun={false}
      isRerunPending={false}
      onRerun={() => {}}
      onOpenWorkspace={() => {}}
      onBack={() => {}}
      outputActions={outputActions}
    />
  )
}

export const withWarnings = defineFixture({
  width: 760,
  render: () => <Page run={warnedRun} />,
  interact: async (frame) => {
    // Collapse the second output to show both states, and open the warning details.
    frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]')[1]?.click()
    frame.querySelector('details')?.setAttribute('open', '')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

export const agentReportedFailure = defineFixture({
  width: 760,
  render: () => (
    <Page
      run={{
        ...baseRun,
        status: 'dispatch_failed',
        error: 'Linear access was denied, so no summary was produced.',
        reportedFailure: {
          message: 'Linear access was denied, so no summary was produced.',
          reportedAt: 2
        }
      }}
    />
  )
})

export const noWarningsReported = defineFixture({
  width: 760,
  render: () => (
    <Page
      run={{
        ...baseRun,
        outputSnapshot: {
          format: 'plain_text',
          content: 'Brief generated.',
          capturedAt: 1,
          truncated: false
        }
      }}
    />
  )
})

export const narrow = defineFixture({ width: 380, render: () => <Page run={warnedRun} /> })

export const savingOutput = defineFixture({
  width: 760,
  render: () => (
    <Page run={warnedRun} outputActions={{ ...actions, open: () => new Promise<void>(() => {}) }} />
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Save and open"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
