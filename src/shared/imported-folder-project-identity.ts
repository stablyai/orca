import {
  GIT_REMOTE_PROJECT_ID_PREFIX,
  getGitRemoteProviderIdentity,
  getProjectIdForProviderIdentity
} from './project-host-setup-projection'
import type { ProjectProviderIdentity } from './project-types'
import type { Repo } from './repo-types'

function sameOwnerAndRepo(left: ProjectProviderIdentity, right: ProjectProviderIdentity): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  )
}

/**
 * Linking stamps the project's identity as the folder's `upstream`, which is only sound when the
 * folder's own remote cannot place it (no remote, a non-GitHub remote). A folder whose remote names
 * another GitHub repository would be silently relabelled into the wrong project (#30663).
 */
export function assertImportedFolderRemoteMatchesProject(
  folder: Pick<Repo, 'gitRemoteIdentity'>,
  projectIdentity: ProjectProviderIdentity
): void {
  const folderIdentity = getGitRemoteProviderIdentity(folder)
  // Why owner/repo only: a remote host can be an SSH alias (`github-work`) that resolves to the
  // project's host, so a host difference alone proves nothing.
  if (!folderIdentity || sameOwnerAndRepo(folderIdentity, projectIdentity)) {
    return
  }
  const remoteName = folder.gitRemoteIdentity?.remoteName ?? 'origin'
  throw new Error(
    `Imported folder does not match the selected project: its Git remote "${remoteName}" points at ${folderIdentity.owner}/${folderIdentity.repo}, not ${projectIdentity.owner}/${projectIdentity.repo}. Choose the project that matches this folder. If the folder is a fork, add the project's repository as its "upstream" remote; if the repository was renamed, update the folder's remote URL.`
  )
}

/**
 * The repo fields that link a folder into `projectId` when it does not project there on its own.
 * A GitHub project stamps its identity as `upstream`. A project keyed by its Git remote (GitLab,
 * Bitbucket, a self-hosted host) records the folder's remote once it names the same repository,
 * since a freshly cloned folder's remote may not have been probed yet.
 */
export function resolveImportedFolderProjectLink(
  folder: Pick<Repo, 'gitRemoteIdentity'>,
  projectId: string,
  providerIdentity: ProjectProviderIdentity | undefined
): Pick<Repo, 'upstream'> | Pick<Repo, 'gitRemoteIdentity'> {
  if (providerIdentity && getProjectIdForProviderIdentity(providerIdentity) === projectId) {
    assertImportedFolderRemoteMatchesProject(folder, providerIdentity)
    return {
      upstream: {
        owner: providerIdentity.owner,
        repo: providerIdentity.repo,
        ...(providerIdentity.host ? { host: providerIdentity.host } : {})
      }
    }
  }
  const remote = folder.gitRemoteIdentity
  if (
    remote &&
    // Why exact: SSH and HTTPS forms already share a canonical key, and projection keys on it.
    `${GIT_REMOTE_PROJECT_ID_PREFIX}${remote.canonicalKey}` === projectId
  ) {
    return { gitRemoteIdentity: remote }
  }
  throw new Error('Imported folder does not match the selected project identity.')
}
