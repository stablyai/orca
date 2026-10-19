import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** The file resolved to something other than an editor in the captured group, so nothing opened. */
export function showOpenInGroupRefusedToast(filePath: string): void {
  toast.error(
    translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.openInThisGroupRefused',
      "Couldn't open {{value0}} in this group",
      { value0: filePath }
    )
  )
}
