import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ClickUpUrlSourceState } from './use-clickup-url-source'

export function getClickUpSourceStatusMessage(
  clickupSource: ClickUpUrlSourceState,
  t: Translate = translate
): string {
  if (clickupSource.loading) {
    return t(
      'auto.components.new.workspace.SmartWorkspaceNameField.loadingClickUp',
      'Loading ClickUp task…'
    )
  }
  switch (clickupSource.errorKind) {
    case 'disconnected':
      return t(
        'auto.components.new.workspace.SmartWorkspaceNameField.clickupDisconnected',
        'Connect ClickUp in Settings to link this task'
      )
    case 'update-runtime':
      return t(
        'auto.components.new.workspace.SmartWorkspaceNameField.clickupRuntimeUpdate',
        'Update the remote runtime to link ClickUp'
      )
    case 'read-failed':
      return t(
        'auto.components.new.workspace.SmartWorkspaceNameField.clickupReadFailed',
        'Couldn’t load this ClickUp task'
      )
    case null:
      return t(
        'auto.components.new.workspace.SmartWorkspaceNameField.clickupLoaded',
        'ClickUp task loaded'
      )
  }
}
