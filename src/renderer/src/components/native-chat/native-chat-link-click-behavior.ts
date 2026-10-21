import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  terminalLinkClickBehaviorFor,
  type TerminalLinkClickBehavior
} from '@/components/terminal-pane/terminal-link-click-behavior'

/** What a plain click on a transcript link does. A profile that only turned the
 *  terminal popover off keeps opening chat links outright, as before actions existed. */
export function nativeChatPlainLinkClickBehavior(
  settings:
    | Pick<GlobalSettings, 'terminalLinkClickBehavior' | 'terminalLinkActionPopoverEnabled'>
    | null
    | undefined
): TerminalLinkClickBehavior {
  if (settings?.terminalLinkClickBehavior === undefined) {
    return settings?.terminalLinkActionPopoverEnabled === false ? 'open' : 'actions'
  }
  return terminalLinkClickBehaviorFor(settings)
}
