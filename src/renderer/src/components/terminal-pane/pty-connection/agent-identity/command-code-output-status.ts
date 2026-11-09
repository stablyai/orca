import { createCommandCodeOutputStatusDetector } from '../../../../../../shared/command-code-output-status'
import { readInFlightCommandCodeTurn } from '../../parking/output-watchers/parked-terminal-command-status'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installCommandCodeOutputStatusDetector(session: ConnectPanePtySession): void {
  // Only byte mode runs Command Code scraping; main facts already drive seed/settle under main authority.
  session.commandCodeOutputStatusDetector = session.mainSideEffectAuthority
    ? null
    : createCommandCodeOutputStatusDetector({
        startupCommand: session.paneStartup?.command,
        // Seed in-flight Command Code turns on reveal; recreated detectors missed the banner and must still recognize idle return.
        inFlightTurn: readInFlightCommandCodeTurn(session.cacheKey),
        onWorking: session.seedCommandCodeOutputWorkingStatus,
        onDone: session.scheduleCommandCodeOutputDoneStatus
      })
}
