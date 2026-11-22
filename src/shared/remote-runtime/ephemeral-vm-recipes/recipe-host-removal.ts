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
