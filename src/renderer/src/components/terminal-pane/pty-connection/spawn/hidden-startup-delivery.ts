import { shouldWritePtyOutputForeground } from '../output/foreground-output-visibility'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindHiddenStartupDelivery(session: ConnectPanePtySession): void {
  // Declare hidden before spawn bytes so main answers startup queries from byte zero; remote-runtime streams never transit this gate.
  session.shouldDeclareHiddenAtSpawn = function (): boolean {
    return (
      session.hiddenDeliveryGateActive &&
      !session.runtimeEnvironmentId &&
      !session.disposed &&
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    )
  }

  // Track hidden claims per PTY so reattach/restart cannot leave old IDs gated; reveal restores bytes main withheld after ingestion.
  session.hiddenDeliverySyncedPtyId = null
  session.releaseHiddenDeliveryClaim = null
  session.modelRestoreSubscribedPtyId = null
  session.unregisterModelRestoreNeeded = null
}
