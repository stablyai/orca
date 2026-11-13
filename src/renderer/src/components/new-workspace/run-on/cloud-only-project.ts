// RUNON-NO-NEW-SANDBOX: a project with no clone on this computer, only on a remote Orca server (a
// paired cloud workspace's, or a server added by hand), can still start a new Orca Cloud sandbox.
// A sandbox clones from GitHub, so it starts like a GitHub-only repository (D4), with the project's
// own GitHub repository picked for the person.
import type { Repo } from '../../../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../../shared/execution-host'
import { orcaCloudGitHubRepoUrl } from '@/lib/orca-cloud/use-orca-cloud-repo-access'
import {
  githubFullNameKey,
  type OrcaCloudGitHubRepository
} from '@/lib/orca-cloud/use-orca-cloud-github-repositories'

type ProjectRepo = Pick<Repo, 'kind' | 'connectionId' | 'executionHostId' | 'gitRemoteIdentity'>

/** The repository lives on a remote Orca server and nowhere on this computer (not SSH, not a folder). */
export function isRemoteServerProject(repo: ProjectRepo | null | undefined): boolean {
  if (!repo || repo.kind === 'folder' || repo.connectionId) {
    return false
  }
  return parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'runtime'
}

/** owner/name (lower case) of a remote-server project's GitHub repository, or null. */
export function remoteServerProjectGitHubKey(repo: ProjectRepo | null | undefined): string | null {
  if (!isRemoteServerProject(repo)) {
    return null
  }
  const url = orcaCloudGitHubRepoUrl(repo)
  return url ? githubFullNameKey(url) : null
}

/**
 * The GitHub repository a cloud-only start uses: the one the person picked, else the project's own
 * (a remote-server project) when Orca Cloud can reach it. Null when neither is listed.
 */
export function pickCloudOnlyRepository(
  repos: readonly OrcaCloudGitHubRepository[] | null,
  pickedName: string | null,
  projectKey: string | null
): OrcaCloudGitHubRepository | null {
  const wanted = (pickedName ?? projectKey)?.toLowerCase()
  if (!repos || !wanted) {
    return null
  }
  return repos.find((repo) => repo.fullName.toLowerCase() === wanted) ?? null
}
