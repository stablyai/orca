import {
  MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY,
  MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY
} from './managed-runtime-install'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
import { SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY } from './ssh-target-management'

export const REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY = 'remote-runtime.shared-control.v1' as const
// Why conditional: only a desktop runtime holds the SSH registry managed servers are run from.
export const MANAGED_SERVER_RUNTIME_CAPABILITY = 'managedServer.v1' as const
// Why: clients offer "Resume automatic restores" only on hosts that can clear a recorded pause.
export const RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY = 'runtime.automatic-work.v1' as const
// Hosts without this capability ignore a request's expectedRuntimeSource; the CLI's pre-send probe
// is then the only fence.
export const RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY = 'runtime-source-fence.v1' as const

// The paired host itself: status, environments, control, updates and the servers it manages.
export const HOST_RUNTIME_CAPABILITIES = [
  'runtime.status.compat.v1',
  'runtime.environments.v1',
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY,
  REMOTE_SERVER_UPDATE_CAPABILITY,
  MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY,
  MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY,
  RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY,
  SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY
] as const
