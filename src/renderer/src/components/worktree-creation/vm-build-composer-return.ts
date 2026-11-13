import type { ComposerModalData } from '@/components/new-workspace/composer-modal-data'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'

type ReturnSource = Pick<PendingWorktreeCreation, 'heldChatMessage' | 'request'>

/** What the user typed for the agent: a prompt queued during the build, else the composer's. */
export function typedComposerPrompt(entry: ReturnSource): string {
  return entry.heldChatMessage ?? entry.request.githubSource?.prompt ?? entry.request.note
}

/**
 * The composer as it was submitted, for a create billing refused before anything started: same
 * project, name, base, agent and prompt. `local` drops the sandbox so it runs on this computer;
 * otherwise the same Run-on target is kept.
 */
export function composerDataFromRefusedCreate(
  entry: ReturnSource,
  { local, pickRepo = false }: { local: boolean; pickRepo?: boolean }
): ComposerModalData {
  const { request } = entry
  const recipe = request.ephemeralVmRecipe
  const github = request.githubSource
  if (github) {
    // The GitHub repository has no clone here: back on Orca Cloud with it picked again; "locally"
    // keeps the composer's own project.
    return {
      ...(github.composerRepoId ? { initialRepoId: github.composerRepoId } : {}),
      ...(local
        ? {}
        : {
            initialEphemeralVmRecipeId: recipe?.recipeId,
            // "Choose another repository": the picker opens instead of the refused one coming back.
            ...(pickRepo
              ? { openCloudRepoPicker: true }
              : { initialCloudGitHubRepo: github.fullName })
          }),
      prefilledName: entry.heldChatMessage ?? github.prompt,
      recovery: { note: '', agent: request.agent },
      telemetrySource: request.telemetrySource ?? 'unknown'
    }
  }
  return {
    initialRepoId: recipe?.sourceRepoId ?? request.repoId,
    ...(!local && recipe ? { initialEphemeralVmRecipeId: recipe.recipeId } : {}),
    ...(pickRepo ? { openCloudRepoPicker: true } : {}),
    // A generated name is regenerated; only a name the user typed comes back.
    ...(request.displayNameKind === 'user' && request.displayName
      ? { prefilledName: request.displayName }
      : {}),
    ...(request.baseBranch ? { initialBaseBranch: request.baseBranch } : {}),
    recovery: { note: typedComposerPrompt(entry), agent: request.agent },
    telemetrySource: request.telemetrySource ?? 'unknown'
  }
}
