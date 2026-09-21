import type { LucideIcon } from 'lucide-react'
import { Clipboard, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'

export type PluginTaskItemDetailAction = {
  label: string
  icon: LucideIcon
  action: () => void
}

async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.TaskPage.pluginTaskSourceCopied', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate(
        'auto.components.TaskPage.pluginTaskSourceCopyFailed',
        'Failed to copy {{value0}}',
        {
          value0: label.toLowerCase()
        }
      )
    )
  }
}

/** URL-bound actions are absent, not disabled, for an item the source gave no
 *  `url`: a control that can never work is worse than no control. */
export function getPluginTaskItemDetailActions(
  item: PluginTaskItem,
  sourceTitle: string
): PluginTaskItemDetailAction[] {
  const urlLabel = translate('auto.components.TaskPage.pluginTaskSourceCopyUrlLabel', 'URL')
  const keyLabel = translate('auto.components.TaskPage.pluginTaskSourceCopyKeyLabel', 'Key')
  const url = item.url
  return [
    ...(url
      ? [
          {
            label: translate(
              'auto.components.TaskPage.pluginTaskSourceOpenIn',
              'Open in {{value0}}',
              { value0: sourceTitle }
            ),
            icon: ExternalLink,
            action: (): void => void window.api.shell.openUrl(url)
          },
          {
            label: translate('auto.components.TaskPage.pluginTaskSourceCopyUrl', 'Copy URL'),
            icon: Clipboard,
            action: (): void => void copyToClipboard(url, urlLabel)
          }
        ]
      : []),
    {
      label: translate('auto.components.TaskPage.pluginTaskSourceCopyKey', 'Copy key'),
      icon: Clipboard,
      action: (): void => void copyToClipboard(item.key, keyLabel)
    }
  ]
}
