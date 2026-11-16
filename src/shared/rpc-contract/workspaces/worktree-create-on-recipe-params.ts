import { z } from 'zod'
import {
  ORCA_VM_RECIPE_ID_PATTERN,
  ORCA_VM_RECIPE_ID_RULE
} from '../../workspace-setup/orca-vm-recipe-id'
import { WorktreeCreate } from './worktree-create-params'

const create = WorktreeCreate.shape

/** What a create on a new recipe environment forwards to that environment's own Orca. */
export const WorktreeCreateOnRecipe = z.object({
  recipeId: z
    .string()
    .regex(ORCA_VM_RECIPE_ID_PATTERN, `Invalid recipe id. ${ORCA_VM_RECIPE_ID_RULE}`),
  /** The source repo on this computer; its orca.yaml declares the recipe. */
  repo: create.repo,
  repoHostId: create.repoHostId,
  name: z.string().trim().min(1, 'Missing workspace name'),
  displayName: create.displayName,
  displayNameKind: create.displayNameKind,
  baseBranch: create.baseBranch,
  branchNameOverride: create.branchNameOverride,
  comment: create.comment,
  setupDecision: create.setupDecision,
  createdWithAgent: create.createdWithAgent
})

export type WorktreeCreateOnRecipeParams = z.infer<typeof WorktreeCreateOnRecipe>
