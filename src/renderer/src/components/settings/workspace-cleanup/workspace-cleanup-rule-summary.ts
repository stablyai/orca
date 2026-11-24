import type { Translate } from '@/i18n/use-translate'
import {
  WORKSPACE_ARCHIVE_SUPPORTED,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'

/** The rules that are on, in a few words each, for a one-line description. */
export function formatWorkspaceCleanupRuleSummary(
  rules: WorkspaceCleanupRules,
  t: Translate
): string {
  const parts: string[] = []
  if (rules.merged.enabled) {
    parts.push(t('components.settings.workspaceCleanup.summary.merged', 'Delete merged'))
  }
  if (rules.unchanged.enabled) {
    parts.push(t('components.settings.workspaceCleanup.summary.unchanged', 'Delete unchanged'))
  }
  if (rules.inactive.enabled) {
    parts.push(
      WORKSPACE_ARCHIVE_SUPPORTED
        ? t('components.settings.workspaceCleanup.summary.inactiveCleanUp', 'Clean up inactive')
        : t('components.settings.workspaceCleanup.summary.inactive', 'Delete inactive')
    )
  }
  if (rules.automationRuns.enabled) {
    parts.push(
      t('components.settings.workspaceCleanup.summary.automationRuns', 'Automation workspaces')
    )
  }
  if (rules.orchestrationWorkers.enabled) {
    parts.push(
      t(
        'components.settings.workspaceCleanup.summary.orchestrationWorkers',
        'Orchestration workers'
      )
    )
  }
  return parts.length > 0
    ? parts.join(', ')
    : t('components.settings.workspaceCleanup.summary.off', 'Off')
}
