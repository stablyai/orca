/**
 * A recipe VM workspace runs on its VM's own Orca server, which is unreachable while the VM is
 * suspended. Only a request that opens the workspace wakes it: background traffic (status
 * probes, listings, event streams) must never undo a sleep the user asked for.
 */

/** Requests that open a workspace. Every path to a VM's server (the desktop's own calls, the
 *  phone relay, the CLI) reaches it through this one set. */
const RECIPE_VM_WAKE_METHODS: ReadonlySet<string> = new Set(['worktree.activate'])

export type RecipeVmWakeIntent = 'wake' | 'none'

export function recipeVmWakeIntentFor(method: string): RecipeVmWakeIntent {
  return RECIPE_VM_WAKE_METHODS.has(method) ? 'wake' : 'none'
}

/** How long the host holds a request that opens a recipe VM workspace while the VM wakes. */
export const RECIPE_VM_OPEN_HOLD_MS = 3 * 60_000
/** A phone gives up on a request after 30 seconds (the mobile app's request deadline). */
const PHONE_REQUEST_DEADLINE_MS = 30_000
/** What the desktop relay may spend, after the hold, connecting the phone to the woken server. */
export const PHONE_RELAY_CONNECT_BUDGET_MS = 15_000
const PHONE_REPLY_MARGIN_MS = 3_000
/** A phone's open is held only as long as still leaves the relay time to connect and answer
 *  before the phone gives up. */
export const RECIPE_VM_PHONE_OPEN_HOLD_MS =
  PHONE_REQUEST_DEADLINE_MS - PHONE_RELAY_CONNECT_BUDGET_MS - PHONE_REPLY_MARGIN_MS
/** Everything a phone link does to open (server preparation, any hold, grant sync, the socket)
 *  fits in this, so the phone's request is answered before it gives up. */
export const PHONE_RELAY_OPEN_BUDGET_MS = PHONE_REQUEST_DEADLINE_MS - PHONE_REPLY_MARGIN_MS

/** The VM is still resuming after the host held the open as long as it would; the same request
 *  succeeds once it is up. */
export const RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE = 'runtime_environment_waking'
/** The wake failed; opening the workspace again tries again. */
export const RUNTIME_ENVIRONMENT_WAKE_FAILED_ERROR_CODE = 'runtime_environment_wake_failed'
/** The VM is suspended and this request does not open its workspace, so it stays asleep. */
export const RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE = 'runtime_environment_asleep'

/** The desktop holds a request that opens a recipe VM workspace while it wakes the VM, and
 *  answers other requests with the asleep/waking codes instead of dialing a server that is not
 *  there. */
export const HOST_RECIPE_VM_WAKE_CAPABILITY = 'host.recipe-vm-wake.v1' as const

/** Desktop RPC the CLI uses to have the desktop open an environment's VM; resolves once it is up. */
export const RECIPE_VM_WAKE_METHOD = 'runtimeEnvironment.wakeRecipeVm'

export const RUNTIME_ENVIRONMENT_WAKING_MESSAGE =
  "This workspace's VM is waking up. Try again in a moment."
export const RUNTIME_ENVIRONMENT_WAKE_FAILED_MESSAGE =
  "This workspace's VM could not wake up. Open the workspace again to retry."
export const RUNTIME_ENVIRONMENT_SLEPT_MESSAGE =
  'This workspace was put to sleep while it was being opened.'
export const RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE =
  "This workspace's VM is asleep. Open the workspace to wake it."

/** Every refusal a request to a recipe VM's server can get from the host. */
export const RECIPE_VM_REFUSAL_CODES = [
  RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
  RUNTIME_ENVIRONMENT_WAKE_FAILED_ERROR_CODE,
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  // A server the user disconnected is never woken by a client's open.
  'runtime_manually_disconnected'
] as const

/** A host without recipe VMs answers the wake RPC as a host without the method does. */
export class RecipeVmWakeUnavailableError extends Error {
  readonly code = 'method_not_found'

  constructor() {
    super(`Unknown method: ${RECIPE_VM_WAKE_METHOD}`)
    this.name = 'RecipeVmWakeUnavailableError'
  }
}
