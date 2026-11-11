// Which composer Advanced options an Orca Cloud workspace honours (DS-j).
//
// - Sparse/Full checkout: honoured. Orca Cloud provisions in 'orca-worktree' mode and the sparse
//   directories go to the sandbox's own git worktree create, so the control stays.
// - Parent worktree: not honoured. Every new cloud workspace is on its own new sandbox host, and an
//   explicit parent from another host fails the create ("Parent worktree must be on the same
//   execution host as the new worktree."), so the picker is hidden and a parent picked before
//   switching Run on to Orca Cloud is not sent.
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'

export function isOrcaCloudRunOn(recipeId: string | null | undefined): boolean {
  return recipeId === ORCA_CLOUD_RECIPE_ID
}

/** Whether the composer offers (and sends) a parent worktree for this Run on. */
export function runOnHonoursParentWorktree(recipeId: string | null | undefined): boolean {
  return !isOrcaCloudRunOn(recipeId)
}

/** The parent to send with a create: none for Orca Cloud, whatever was picked otherwise. */
export function parentWorktreeForRunOn<T extends string | null | undefined>(
  recipeId: string | null | undefined,
  parentWorktreeId: T
): T | undefined {
  return runOnHonoursParentWorktree(recipeId) ? parentWorktreeId : undefined
}
