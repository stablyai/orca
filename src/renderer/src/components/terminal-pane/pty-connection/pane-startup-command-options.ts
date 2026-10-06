import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { UnstageableLine } from '../../../../../shared/launch-prompt-file'

/** The startup command a pane spawn sends, with the launch file and prompt it carries; none when
 *  the startup is delivered by terminal paste instead. */
export function paneStartupCommandOptions(session: ConnectPanePtySession): {
  command?: string
  launchFile?: NonNullable<ConnectPanePtySession['paneStartup']>['launchFile']
  launchPrompt?: string
  unstageableLine?: UnstageableLine
} {
  if (session.shouldDeliverStartupViaTerminalPaste) {
    return {}
  }
  return {
    command: session.paneStartup?.command,
    launchFile: session.paneStartup?.launchFile,
    launchPrompt: session.paneStartup?.launchPrompt,
    unstageableLine: session.paneStartup?.unstageableLine
  }
}
