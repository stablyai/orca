// @protected-copy scope=file
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function workspaceCleanupChangeMessage(
  kind: 'save' | 'conflict' | 'preview' | 'checking',
  t: Translate = translate
): string {
  switch (kind) {
    case 'save':
      return t(
        'components.settings.workspaceCleanup.change.saveFailed',
        "Couldn't save. Rule not changed."
      )
    case 'conflict':
      return t(
        'components.settings.workspaceCleanup.change.conflict',
        'The cleanup rules changed elsewhere. Review the change again.'
      )
    case 'preview':
      return t(
        'components.settings.workspaceCleanup.change.previewFailed',
        "Couldn't check which workspaces match."
      )
    case 'checking':
      return t('components.settings.workspaceCleanup.change.checkingSaved', 'Checking saved rules…')
  }
}
