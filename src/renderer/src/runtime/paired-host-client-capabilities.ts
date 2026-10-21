import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime-client-capabilities'
import { isWebClientLocation } from '@/lib/web-client-location'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '@/web/web-runtime-client-capabilities'

/** What this client tells a paired host it can do, exactly as its handshake sends it: the desktop's
 *  transports add the shared remote base to the Electron list; the browser client sends its own. */
export function pairedHostClientCapabilities(): readonly string[] {
  return isWebClientLocation()
    ? WEB_RUNTIME_CLIENT_CAPABILITIES
    : remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
}
