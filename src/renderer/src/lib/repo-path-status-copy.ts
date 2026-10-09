import { translate } from '@/i18n/i18n'
import type { RepoPathStatus, RepoRelinkErrorCode } from '../../../shared/repo-path-status'

/** The statuses the sidebar acts on; `present` and `unverifiable` show nothing. */
export type ActionableRepoPathStatus = Extract<RepoPathStatus, { state: 'missing' | 'moved' }>

export function isActionableRepoPathStatus(
  status: RepoPathStatus | null | undefined
): status is ActionableRepoPathStatus {
  // Why the explicit list: a newer host may send a state this build cannot act on.
  return status?.state === 'missing' || status?.state === 'moved'
}

export function getRepoPathStatusTitle(status: ActionableRepoPathStatus): string {
  if (status.state === 'moved') {
    return translate('auto.lib.repoPathStatus.title.moved', 'Repository moved')
  }
  switch (status.reason) {
    case 'not-git-root':
      return translate(
        'auto.lib.repoPathStatus.title.notGitRoot',
        'Folder is no longer a Git repository'
      )
    case 'not-directory':
      return translate(
        'auto.lib.repoPathStatus.title.notDirectory',
        'Repository path is not a folder'
      )
    case 'not-found':
      return translate('auto.lib.repoPathStatus.title.missing', 'Repository folder not found')
  }
  // A reason a newer host invented still reads as missing.
  return translate('auto.lib.repoPathStatus.title.missing', 'Repository folder not found')
}

export function getRepoPathStatusDescription(
  status: ActionableRepoPathStatus,
  path: string
): string {
  if (status.state === 'moved') {
    return translate(
      'auto.lib.repoPathStatus.description.moved',
      'Moved to {{target}}. Update the location?',
      { target: status.target }
    )
  }
  return translate(
    'auto.lib.repoPathStatus.description.missing',
    'Orca cannot find a Git repository at {{path}}. Locate the folder to keep its worktrees and tabs.',
    { path }
  )
}

/** Localized guidance for the refusals a user may override; null means show the host's detail. */
export function getRepoRelinkErrorDescription(
  code: RepoRelinkErrorCode | null,
  name: string
): string | null {
  if (code === 'repo_relink_identity_unverified') {
    return translate(
      'auto.lib.repoPathStatus.errorDescription.identityUnverified',
      'It shares no remote or linked worktree with {{name}}. Relink anyway only if you know it is the same repository.',
      { name }
    )
  }
  if (code === 'repo_relink_different_repository') {
    return translate(
      'auto.lib.repoPathStatus.errorDescription.differentRepository',
      "Its remotes differ from {{name}}'s. Relinking would attach this project's worktree names and tabs to it.",
      { name }
    )
  }
  return null
}

function genericRelinkErrorTitle(): string {
  return translate('auto.lib.repoPathStatus.error.generic', 'Cannot use this folder')
}

export function getRepoRelinkErrorTitle(code: RepoRelinkErrorCode | null): string {
  switch (code) {
    case 'repo_relink_different_repository':
      return translate(
        'auto.lib.repoPathStatus.error.differentRepository',
        'This looks like a different repository'
      )
    case 'repo_relink_identity_unverified':
      return translate(
        'auto.lib.repoPathStatus.error.identityUnverified',
        'Orca cannot confirm this is the same repository'
      )
    case 'repo_relink_host_unverifiable':
      return translate('auto.lib.repoPathStatus.error.hostUnverifiable', 'Cannot reach the host')
    case 'repo_relink_path_not_found':
    case 'repo_relink_path_not_directory':
    case 'repo_relink_path_not_absolute':
    case 'repo_relink_not_git_toplevel':
    case 'repo_relink_path_registered':
    case 'repo_relink_folder_repo_unsupported':
    case null:
      return genericRelinkErrorTitle()
  }
  return genericRelinkErrorTitle()
}
