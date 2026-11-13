import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// The upload or path resolution already succeeded; a pane that closed or parked
// meanwhile must not silently swallow where the files landed.
export function showTerminalDropTargetGone(paths: readonly string[]): void {
  if (paths.length === 0) {
    return
  }
  const copyText = paths.join('\n')
  toast.message(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.writeTargetGone',
      "Upload finished, but the terminal wasn't open to type the path. Files are at:"
    ),
    {
      description: paths.join('  '),
      // Long remote paths need time to read or copy, so keep the toast until the user acts on it.
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: translate('menu.copy', 'Copy'),
        onClick: () => {
          void window.api.ui.writeClipboardText(copyText)
        }
      }
    }
  )
}
