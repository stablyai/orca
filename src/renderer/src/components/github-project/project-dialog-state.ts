type RepoBackedProjectDialogState = {
  repoId: string
}

type SlugProjectDialogState = {
  origin: {
    owner: string
    repo: string
  }
}

type RepoNotInOrcaDialogState = {
  owner: string
  repo: string
}

type LookupSlug = (slug: string) => readonly unknown[]

function hasRepoMatch(lookupSlug: LookupSlug, owner: string, repo: string): boolean {
  return lookupSlug(`${owner}/${repo}`).length > 0
}

export function resolveRepoBackedProjectDialogState<T extends RepoBackedProjectDialogState>(
  dialog: T | null,
  liveRepoIds: ReadonlySet<string>
): T | null {
  if (dialog && !liveRepoIds.has(dialog.repoId)) {
    return null
  }
  return dialog
}

export function resolveMissingRepoProjectDialogState<
  TSlugDialog extends SlugProjectDialogState,
  TRepoNotInOrca extends RepoNotInOrcaDialogState
>(args: {
  slugIndexReady: boolean
  slugDialog: TSlugDialog | null
  repoNotInOrca: TRepoNotInOrca | null
  lookupSlug: LookupSlug
}): {
  slugDialog: TSlugDialog | null
  repoNotInOrca: TRepoNotInOrca | null
} {
  const { lookupSlug, repoNotInOrca, slugDialog, slugIndexReady } = args
  if (!slugIndexReady) {
    return { slugDialog, repoNotInOrca }
  }
  return {
    slugDialog:
      slugDialog && hasRepoMatch(lookupSlug, slugDialog.origin.owner, slugDialog.origin.repo)
        ? null
        : slugDialog,
    repoNotInOrca:
      repoNotInOrca && hasRepoMatch(lookupSlug, repoNotInOrca.owner, repoNotInOrca.repo)
        ? null
        : repoNotInOrca
  }
}
