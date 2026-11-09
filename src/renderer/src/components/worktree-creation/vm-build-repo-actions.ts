import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { normalizeGitRemoteUrl } from '../../../../shared/git/remotes/git-remote-identity'
import type { Repo } from '../../../../shared/repo-types'

/** GitHub's guide to publishing a local repository: the fix for a repo Orca Cloud can't clone. */
export const PUSH_TO_GITHUB_URL =
  'https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github'

/** The repository as the user knows it: its GitHub owner/name, else its name in Orca. */
export function orcaCloudRepoName(
  repo: Pick<Repo, 'displayName' | 'gitRemoteIdentity'> | undefined
): string {
  const remote = repo?.gitRemoteIdentity?.remoteUrl
  const normalized = remote ? normalizeGitRemoteUrl(remote) : null
  if (normalized?.startsWith('github.com/')) {
    return normalized.slice('github.com/'.length)
  }
  return repo?.displayName ?? ''
}

/** Retries the create without the repository: the user chose an empty cloud workspace. */
export function startOrcaCloudCreateEmpty(creationId: string, retry: () => void): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  const recipe = entry?.request.ephemeralVmRecipe
  if (!entry || !recipe) {
    return
  }
  store.updatePendingWorktreeCreation(creationId, {
    request: { ...entry.request, ephemeralVmRecipe: { ...recipe, startEmpty: true } }
  })
  retry()
}

/** Opens GitHub so the account can give Orca Cloud access; the user comes back and tries again. */
export async function connectOrcaCloudGitHub(): Promise<void> {
  const result = await window.api.orcaCloudWorkspace.connectGitHub().catch(() => null)
  if (!result?.ok) {
    toast.error(
      translate(
        'auto.components.worktree.creation.VmBuildFailureCard.connectGitHubFailed',
        'Couldn’t open GitHub. Try again in a moment.'
      )
    )
  }
}
