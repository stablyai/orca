import { ORCAD_IDLE_TIMEOUT_ENV } from './orcad-idle-exit'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from './orcad-managed-launch-env'

/** WSL-host launch marker; SSH guests and WSLg retain their original PATH. */
export const ORCAD_WSL_HOST_ENV = 'ORCA_WSL_ORCAD_HOST'

/** Desktop-provided registry ID; guests cannot read it themselves. */
export const ORCAD_WSL_DISTRO_GUID_ENV = 'ORCA_WSL_DISTRO_GUID'

/**
 * What a client puts in a server's launch env. A user's own `orcad` started from one of the
 * server's shells is not that server, so every pane scrubs these.
 */
export const ORCAD_SERVER_LAUNCH_ENV_KEYS = [
  // Not client-managed.
  ORCAD_MANAGED_ACTIVATION_ROOT_ENV,
  // Keeps the default idle window.
  ORCAD_IDLE_TIMEOUT_ENV,
  // Not a WSL host: no migration capabilities, no /mnt/c refusal, no account-push wait.
  ORCAD_WSL_HOST_ENV,
  ORCAD_WSL_DISTRO_GUID_ENV
] as const
