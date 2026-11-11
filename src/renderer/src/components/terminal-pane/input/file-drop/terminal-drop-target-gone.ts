import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// The upload or path resolution already succeeded; a pane that closed or parked
// meanwhile must not silently swallow where the files landed.
export function showTerminalDropTargetGone(paths: readonly string[]): void {
  if (paths.length === 0) {
    return
  }
  toast.message(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.writeTargetGone',
      'The terminal closed before the drop could be typed. Files are at:'
    ),
    { description: paths.join('  ') }
  )
}
