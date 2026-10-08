import type { Repo } from './repo-types'

export function getRepoKind(repo: Pick<Repo, 'kind'>): 'git' | 'folder' {
  return repo.kind === 'folder' ? 'folder' : 'git'
}

export function isFolderRepo(repo: Pick<Repo, 'kind'>): boolean {
  return getRepoKind(repo) === 'folder'
}

export function isGitRepoKind(repo: Pick<Repo, 'kind'>): boolean {
  return getRepoKind(repo) === 'git'
}

/** A folder project inside a Perforce workspace: its workspaces are Perforce copies, like Git worktrees. */
export function isPerforceRepo(repo: Pick<Repo, 'kind' | 'vcs'>): boolean {
  return isFolderRepo(repo) && repo.vcs === 'perforce'
}

export function getRepoKindLabel(repo: Pick<Repo, 'kind' | 'vcs'>): string {
  if (isPerforceRepo(repo)) {
    return 'Perforce'
  }
  return isFolderRepo(repo) ? 'Folder' : 'Git'
}
