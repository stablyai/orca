import type { Repo } from './repo-types'
import { parseWorkspaceKey } from './workspace-scope'

export function getRepoKind(repo: Pick<Repo, 'kind'>): 'git' | 'folder' {
  return repo.kind === 'folder' ? 'folder' : 'git'
}

export function isFolderRepo(repo: Pick<Repo, 'kind'>): boolean {
  return getRepoKind(repo) === 'folder'
}

export function isGitRepoKind(repo: Pick<Repo, 'kind'>): boolean {
  return getRepoKind(repo) === 'git'
}

export function getRepoKindLabel(repo: Pick<Repo, 'kind'>): string {
  return isFolderRepo(repo) ? 'Folder' : 'Git'
}

// Folder workspaces and folder repos have no Git, so Git-only surfaces such as Source Control stand down.
export function isGitlessWorkspace(
  workspaceId: string,
  repo: Pick<Repo, 'kind'> | null | undefined
): boolean {
  return parseWorkspaceKey(workspaceId)?.type === 'folder' || (repo ? isFolderRepo(repo) : false)
}
