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

/** Stamping upstream is sound only without a usable GitHub remote; a different repository would be silently assigned to the wrong project (#30663). */
export function assertImportedFolderRemoteMatchesProject(
  folder: Pick<Repo, 'gitRemoteIdentity'>,
  projectIdentity: ProjectProviderIdentity
): void {
  const folderIdentity = getGitRemoteProviderIdentity(folder)
  // Host mismatches cannot disprove identity: SSH aliases such as github-work may resolve to the project’s host.
  if (!folderIdentity || sameOwnerAndRepo(folderIdentity, projectIdentity)) {
    return
  }
  const remoteName = folder.gitRemoteIdentity?.remoteName ?? 'origin'
  throw new Error(
    `Imported folder does not match the selected project: its Git remote "${remoteName}" points at ${folderIdentity.owner}/${folderIdentity.repo}, not ${projectIdentity.owner}/${projectIdentity.repo}. Choose the project that matches this folder. If the folder is a fork, add the project's repository as its "upstream" remote; if the repository was renamed, update the folder's remote URL.`
  )
}

/** Supply missing project links: GitHub projects stamp upstream; remote-keyed projects record matching remotes not yet probed after cloning. */
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
