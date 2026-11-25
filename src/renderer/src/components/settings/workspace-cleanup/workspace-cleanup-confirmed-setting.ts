import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupRuleKey } from './workspace-cleanup-rule-keys'

export type WorkspaceCleanupConfirmedSetting = WorkspaceCleanupRuleKey | 'keepIgnoredFiles' | 'mode'
export function workspaceCleanupConfirmedSettingTitle(
  setting: WorkspaceCleanupConfirmedSetting
): string {
  switch (setting) {
    case 'merged':
      return translate(
        'components.settings.workspaceCleanup.rules.merged',
        'Delete merged workspaces'
      )
    case 'unchanged':
      return translate(
        'components.settings.workspaceCleanup.rules.unchanged',
        'Delete unchanged workspaces'
      )
    case 'inactive':
      return translate(
        'components.settings.workspaceCleanup.rules.inactive',
        'Delete inactive workspaces'
      )
    case 'automationRuns':
      return translate(
        'components.settings.workspaceCleanup.rules.automationRuns',
        'Delete finished automation workspaces'
      )
    case 'orchestrationWorkers':
      return translate(
        'components.settings.workspaceCleanup.rules.orchestrationWorkers',
        'Delete released orchestration worker workspaces'
      )
    case 'keepIgnoredFiles':
      return translate(
        'components.settings.workspaceCleanup.protection.keepIgnoredFiles',
        'Keep workspaces with ignored files'
      )
    case 'mode':
      return translate('components.settings.repository.workspaceCleanup.title', 'Workspace cleanup')
  }
}
