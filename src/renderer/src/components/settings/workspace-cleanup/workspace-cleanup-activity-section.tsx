import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { WorkspaceCleanupActivityList } from './workspace-cleanup-activity-list'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'
import type { WorkspaceCleanupHostReport } from './use-workspace-cleanup-host-activity'

/** What each run removed and kept, or why there is nothing to show. */
export function WorkspaceCleanupActivitySection({
  hostReport
}: {
  hostReport: WorkspaceCleanupHostReport
}): React.JSX.Element {
  const t = useTranslate()
  const search = getWorkspaceCleanupSettingsSearchParts()
  const report = hostReport.state === 'ready' ? hostReport.report : null
  const note =
    hostReport.state === 'error'
      ? t(
          'components.settings.workspaceCleanup.activity.loadFailed',
          "Couldn't load activity: {{error}}",
          { error: hostReport.message }
        )
      : report && report.runs.length === 0
        ? t('components.settings.workspaceCleanup.activity.empty', "Cleanup hasn't run yet.")
        : null
  return (
    <SettingsGroup title={search.activity.title}>
      {note ? (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
      {report && report.runs.length > 0 ? (
        <WorkspaceCleanupActivityList runs={report.runs} />
      ) : null}
    </SettingsGroup>
  )
}
