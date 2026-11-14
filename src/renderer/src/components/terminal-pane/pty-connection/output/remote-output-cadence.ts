import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { shouldWritePtyOutputForeground } from './foreground-output-visibility'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** Only the pane being typed into needs the host's 5ms flush; visible siblings tolerate coarser frames. */
export function syncRemoteOutputCadence(session: ConnectPanePtySession): void {
  if (session.disposed || !isRemoteRuntimePtyId(session.transport.getPtyId())) {
    return
  }
  // Why optional: lifecycle can sync before deferred output setup installs isActiveSplitPane.
  const focused =
    shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) &&
    session.isActiveSplitPane?.() !== false
  session.transport.setOutputCadence?.(focused ? 'focused' : 'background')
}
