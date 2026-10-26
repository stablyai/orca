import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../shared/managed-account-types'
import { getRendererAppPlatform } from './renderer-app-platform'

function normalizeFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return getRendererAppPlatform() === 'win32' ? slashed.toLowerCase() : slashed
}

/** The host's Claude folders and logins as main read them at the switch; WSL guests' are never read. */
export type ClaudeHostFolders = Pick<
  ClaudeRateLimitAccountsState,
  'accounts' | 'systemDefaultHome' | 'systemDefaultEmail' | 'systemDefaultOrganizationUuid'
>

/** Where a pane's Claude keeps its config, read from its transcript path. */
export type ClaudePaneFolder =
  | { kind: 'account'; accountId: string }
  | { kind: 'system-default' }
  | { kind: 'own-folder' }

/** Undefined means no hook evidence; without the host's default home every unmanaged folder is System default. */
export function resolveClaudePaneFolder(
  transcriptPath: string | undefined,
  saved: readonly ClaudeManagedAccount[],
  host?: ClaudeHostFolders
): ClaudePaneFolder | undefined {
  const transcript = transcriptPath ? normalizeFolder(transcriptPath) : ''
  const projectsIndex = transcript.lastIndexOf('/projects/')
  if (projectsIndex <= 0) {
    return undefined
  }
  const configDir = transcript.slice(0, projectsIndex)
  const isConfigDir = (folder: string | null | undefined): boolean =>
    !!folder && normalizeFolder(folder) === configDir
  const account =
    saved.find((candidate) =>
      [candidate.managedAuthPath, candidate.wslLinuxAuthPath].some(isConfigDir)
    ) ?? host?.accounts.find((candidate) => isConfigDir(candidate.home))
  if (account) {
    return { kind: 'account', accountId: account.id }
  }
  return !host?.systemDefaultHome || isConfigDir(host.systemDefaultHome)
    ? { kind: 'system-default' }
    : { kind: 'own-folder' }
}

/**
 * Whether a pane runs on an account (null is System default). A System default pane also counts
 * when that folder is signed in to the account's own login, as an older Orca's copied login is.
 * Managed folders are never compared by login: two saved accounts may share one on purpose.
 */
export function isClaudePaneOnAccount(
  folder: ClaudePaneFolder | undefined,
  accountId: string | null,
  host?: ClaudeHostFolders
): boolean {
  if (folder?.kind === 'account') {
    return folder.accountId === accountId
  }
  if (folder?.kind !== 'system-default') {
    return false
  }
  if (accountId === null) {
    return true
  }
  const account = host?.accounts.find((candidate) => candidate.id === accountId)
  // Why strict: a missing organization never matches, since one email can hold personal and team logins.
  return (
    !!host?.systemDefaultEmail &&
    !!host.systemDefaultOrganizationUuid &&
    !!account &&
    // Why: only a signed-in folder's summary carries that folder's login rather than the saved one.
    !account.needsSignIn &&
    !account.runsOnSystemDefault &&
    account.organizationUuid === host.systemDefaultOrganizationUuid &&
    account.email.trim().toLowerCase() === host.systemDefaultEmail.trim().toLowerCase()
  )
}
