import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_ARCHIVE_SUPPORTED } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

function cleanupKeywords(): string[] {
  return [
    ...translateSearchKeyword('components.settings.workspaceCleanup.search.cleanup', 'cleanup'),
    ...translateSearchKeyword('components.settings.workspaceCleanup.search.cleanUp', 'clean up'),
    ...translateSearchKeyword('components.settings.workspaceCleanup.search.delete', 'delete')
  ]
}

/** One entry per searchable row; each row's SearchableSetting uses the same title. */
export const getWorkspaceCleanupSettingsSearchParts = createLocalizedCatalog(
  () =>
    ({
      status: {
        title: translate('components.settings.workspaceCleanup.cleanUpNow', 'Clean up now'),
        description: translate(
          'components.settings.workspaceCleanup.search.statusDescription',
          'Run the cleanup rules now, or review workspaces yourself.'
        ),
        keywords: [
          ...translateSearchKeyword(
            'components.settings.workspaceCleanup.search.reviewWorkspaces',
            'review workspaces'
          ),
          ...translateSearchKeyword(
            'components.settings.workspaceCleanup.search.automatic',
            'automatic'
          )
        ]
      },
      merged: {
        title: translate(
          'components.settings.workspaceCleanup.rules.merged',
          'Delete merged workspaces'
        ),
        description: translate(
          'components.settings.workspaceCleanup.rules.mergedDescription',
          'The pull request is merged and everything in the workspace is in it.'
        ),
        keywords: [
          ...cleanupKeywords(),
          ...translateSearchKeyword('components.settings.workspaceCleanup.search.pullRequest', 'PR')
        ]
      },
      unchanged: {
        title: translate(
          'components.settings.workspaceCleanup.rules.unchanged',
          'Delete unchanged workspaces'
        ),
        description: translate(
          'components.settings.workspaceCleanup.rules.unchangedDescription',
          'No commits beyond the default branch and no edits.'
        ),
        keywords: cleanupKeywords()
      },
      inactive: {
        // Until archiving exists the rule deletes, so it says so.
        title: WORKSPACE_ARCHIVE_SUPPORTED
          ? translate(
              'components.settings.workspaceCleanup.rules.inactiveCleanUp',
              'Clean up inactive workspaces'
            )
          : translate(
              'components.settings.workspaceCleanup.rules.inactive',
              'Delete inactive workspaces'
            ),
        description: translate(
          'components.settings.workspaceCleanup.search.inactiveDescription',
          'No activity for a number of days.'
        ),
        keywords: [
          ...cleanupKeywords(),
          ...translateSearchKeyword('components.settings.workspaceCleanup.search.stale', 'stale'),
          ...translateSearchKeyword('components.settings.workspaceCleanup.search.days', 'days')
        ]
      },
      automationRuns: {
        title: translate(
          'components.settings.workspaceCleanup.rules.automationRuns',
          'Delete finished automation workspaces'
        ),
        description: translate(
          'components.settings.workspaceCleanup.rules.automationRunsDescription',
          'Workspaces an automation run created, once the run has finished.'
        ),
        keywords: [
          ...translateSearchKeyword(
            'components.settings.workspaceCleanup.search.automations',
            'automations'
          )
        ]
      },
      orchestrationWorkers: {
        title: translate(
          'components.settings.workspaceCleanup.rules.orchestrationWorkers',
          'Delete released orchestration worker workspaces'
        ),
        description: translate(
          'components.settings.workspaceCleanup.rules.orchestrationWorkersDescription',
          'Workspaces an orchestration worker used, once the coordinator has released it.'
        ),
        keywords: [
          ...translateSearchKeyword(
            'components.settings.workspaceCleanup.search.orchestration',
            'orchestration'
          )
        ]
      },
      keepIgnoredFiles: {
        title: translate(
          'components.settings.workspaceCleanup.protection.keepIgnoredFiles',
          'Keep workspaces with ignored files'
        ),
        description: translate(
          'components.settings.workspaceCleanup.protection.keepIgnoredFilesDescription',
          "Files like .env and local config can't be recovered. node_modules and build output don't count."
        ),
        keywords: [
          ...translateSearchKeyword(
            'components.settings.workspaceCleanup.search.protection',
            'protection'
          ),
          ...translateSearchKeyword('components.settings.workspaceCleanup.search.envFile', '.env', {
            englishOnly: true
          })
        ]
      },
      activity: {
        title: translate('components.settings.workspaceCleanup.activity.title', 'Activity'),
        description: translate(
          'components.settings.workspaceCleanup.search.activityDescription',
          'What each cleanup run removed and kept.'
        ),
        keywords: [
          ...translateSearchKeyword(
            'components.settings.workspaceCleanup.search.history',
            'history'
          ),
          ...translateSearchKeyword('components.settings.workspaceCleanup.search.runs', 'runs')
        ]
      }
    }) satisfies Record<string, SettingsSearchEntry>
)

export function getWorkspaceCleanupSettingsSearchEntries(): SettingsSearchEntry[] {
  return Object.values(getWorkspaceCleanupSettingsSearchParts())
}
