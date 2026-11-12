/** Each host-side step of a recipe removal (checkout removal, emptiness check) gets this long. */
export const RECIPE_REMOVAL_REQUEST_TIMEOUT_MS = 600_000
/** The phone waits for the whole removal, including the recipe's destroy step. */
export const RECIPE_REMOVAL_REPLY_TIMEOUT_MS = 1_800_000

/** What a phone's delete sheet says about the environment a desktop created for a workspace. */
export type RecipeEnvironmentDescription = {
  name: string
  /** False when the recipe has no destroy step or disables it: deleting leaves it running. */
  destroys: boolean
}

/** What removing a recipe workspace did to the environment Orca created for it. */
export type RecipeHostRemovalState =
  | 'destroyed'
  // Other workspaces still live on it, or the environment couldn't say it was empty.
  | 'kept'
  // The recipe has no destroy step, so nothing could destroy it.
  | 'left-running'

/** A recipe workspace removal failure that keeps the code and data its environment returned. */
export class RecipeWorkspaceRemovalError extends Error {
  readonly code: string
  readonly data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/**
 * REG-12: an Orca Cloud workspace's delete either destroys its sandbox or fails visibly. It never
 * reports success while the sandbox is kept (another workspace on it, or no proof it is empty).
 */
export const CLOUD_DELETE_NOT_SENT = 'cloud_delete_not_sent'
export const CLOUD_DELETE_NOT_SENT_UNCHECKED =
  "Orca Cloud couldn't check this sandbox, so it wasn't deleted. Try again."
export const CLOUD_DELETE_NOT_SENT_IN_USE =
  "Other workspaces still run in this sandbox, so it wasn't deleted. Delete them first, then try again."
export const CLOUD_DELETE_NOT_SENT_NO_DESTROY = "Orca Cloud didn't delete this sandbox. Try again."

/** The removal failed before any sandbox delete was sent: retrying is safe and may succeed. */
export function isCloudDeleteNotSentError(message: string): boolean {
  return [
    CLOUD_DELETE_NOT_SENT_UNCHECKED,
    CLOUD_DELETE_NOT_SENT_IN_USE,
    CLOUD_DELETE_NOT_SENT_NO_DESTROY
  ].some((copy) => message.includes(copy))
}
