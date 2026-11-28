import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { WorkspaceCleanupRuleChangeDialog } from './workspace-cleanup-rule-change-dialog'

const MB = 1024 * 1024
const LONG_PROJECT = 'customer-facing-analytics-dashboard-monorepo'

function row(
  name: string,
  evaluation: WorkspaceCleanupPreviewRow['evaluation'],
  overrides: Partial<WorkspaceCleanupPreviewRow> = {}
): WorkspaceCleanupPreviewRow {
  const repoName = overrides.repoName ?? 'example-project'
  return {
    worktreeId: `${repoName}::/repo/${name}`,
    repoId: repoName,
    repoName,
    displayName: name,
    branch: name,
    path: `/Users/me/code/${repoName}/${name}`,
    evaluation,
    ...overrides
  }
}

// The confirmation a rule change opens in Settings: each newly matching workspace with its reason chip.
const ROWS: WorkspaceCleanupPreviewRow[] = [
  row(
    'fix-settings-pane-width',
    { action: 'delete', reason: 'merged' },
    { prNumber: 42, sizeBytes: 1_288 * MB }
  ),
  row(
    'worker-translate-catalogs',
    { action: 'archive', reason: 'orchestration-worker' },
    { sizeBytes: 96 * MB }
  ),
  row(
    'investigate-flaky-settings-pane-layout-on-minimum-window',
    { action: 'delete', reason: 'inactive' },
    { repoName: LONG_PROJECT }
  )
]

export const enableRule = defineFixture({
  width: 600,
  render: () => (
    <WorkspaceCleanupRuleChangeDialog
      request={{ kind: 'enable', ruleTitle: 'Merged pull requests', rows: ROWS }}
      onCancel={() => {}}
      onConfirm={async () => {}}
    />
  )
})
