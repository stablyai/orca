import { getGitRemoteProviderIdentity } from './project-host-setup-projection'
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
