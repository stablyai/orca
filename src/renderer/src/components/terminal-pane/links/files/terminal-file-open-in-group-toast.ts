import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** The resolved route cannot honor the captured group. */
export function showOpenInGroupRefusedToast(filePath: string): void {
  toast.error(
    translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.openInThisGroupRefused',
      "Couldn't open {{value0}} in this group",
      { value0: filePath }
    )
  )
}

export function refuseOpenInGroupRequest(
  filePath: string,
  explicit: boolean,
  isCurrent: () => boolean
): boolean {
  if (!explicit) {
    return false
  }
  if (isCurrent()) {
    showOpenInGroupRefusedToast(filePath)
  }
  return true
}
