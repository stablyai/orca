// The desktop's reads of the GitHub routes; the cloud's side lands with them (plan G3).
// Every route acts as the caller's Orca account: confirm and set-default touch only that account's
// own link and default, and a link token is single use.
import * as z from 'zod'
import { lazyZodSchema } from './schema/lazy-zod-schema'

/** How people ask a bot on GitHub: "@orca-bots ranger …" in an issue or pull request comment. */
export const GITHUB_BOT_MENTION = '@orca-bots'

// Exactly the cloud's (connector-contract), so both sides accept the same ids and logins.
/** GitHub's numeric ids (users, installations), as strings. */
export const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const GitHubId = z.string().regex(GITHUB_ID_PATTERN)
/** A GitHub user or organization name, Enterprise Managed Users' `_shortcode` included. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/
const GitHubLogin = z.string().regex(GITHUB_LOGIN_PATTERN)

const GitHubUser = lazyZodSchema(() =>
  z.object({
    /** The only thing the cloud matches a comment's author on. */
    userId: GitHubId,
    login: GitHubLogin
  })
)

/** One GitHub user the Orca account is linked as; each counts as the owner. */
const GitHubLinkedAccount = lazyZodSchema(() =>
  GitHubUser.extend({
    /** The ids of the installations this user can see. */
    installations: z.array(GitHubId),
    /** Who takes this user's requests when a comment names none; null when unset. */
    defaultBotId: z.string().nullable()
  })
)
export type ConnectorGitHubLinkedAccount = z.infer<typeof GitHubLinkedAccount>

// GET `${github}/state`: the GitHub users this Orca account is linked as, and the Orca app's
// installations they can see.
export const ConnectorGitHubState = lazyZodSchema(() =>
  z.object({
    /** GitHub's install page for the Orca app, signed for this account. */
    installUrl: z.string().url(),
    /** The first linked user; null until the owner connects GitHub from Orca. */
    account: GitHubUser.nullable(),
    /** Every linked user, oldest first; missing from an older cloud, which links one (`account`).
     *  Read entry by entry: an entry this build can't read is left out, never the whole list, since a
     *  present list is what scopes Unlink to one user. */
    accounts: z
      .unknown()
      .transform((value): ConnectorGitHubLinkedAccount[] =>
        (Array.isArray(value) ? value : []).flatMap((entry) => {
          const parsed = GitHubLinkedAccount.safeParse(entry)
          return parsed.success ? [parsed.data] : []
        })
      )
      .optional(),
    installations: z.array(
      z.object({
        installationId: GitHubId,
        /** The user or organization the app is installed on. */
        accountLogin: GitHubLogin,
        /** Null when the app may use every repository of that account. */
        repositories: z.array(z.object({ fullName: z.string().min(1) })).nullable()
      })
    ),
    /** The first linked user's default (see `accounts`). */
    defaultBotId: z.string().nullable(),
    /** gh's sign-in on the host that answered, which its bots act through; set by the host, never
     *  by the cloud. Absent from an older host; a value this build doesn't know reads as absent. */
    gh: z.enum(['signed-in', 'signed-out', 'missing']).optional().catch(undefined)
  })
)
export type ConnectorGitHubState = z.infer<typeof ConnectorGitHubState>
export type ConnectorGitHubInstallation = ConnectorGitHubState['installations'][number]

// GET `${github}/users?q=<username>`: the GitHub user with that username, found by exact match, as
// {id: numeric user id, name: login}; complete as for Slack's.
export const ConnectorGitHubUsersResponse = lazyZodSchema(() =>
  z.object({
    members: z.array(z.object({ id: GitHubId, name: GitHubLogin })),
    complete: z.boolean()
  })
)
export type ConnectorGitHubUsersResponse = z.infer<typeof ConnectorGitHubUsersResponse>

/** The desktop's own code for a cloud with GitHub off (every GitHub route answers 404). */
export const BOT_GITHUB_OFF = 'github_off'

/** Every linked GitHub user, as rows; an older cloud's one `account` (or the first, when no entry
 *  of `accounts` could be read) is the only one. */
export function gitHubLinkedAccounts(state: ConnectorGitHubState): ConnectorGitHubLinkedAccount[] {
  if (state.accounts && state.accounts.length > 0) {
    return state.accounts
  }
  return state.account
    ? [
        {
          ...state.account,
          installations: state.installations.map((entry) => entry.installationId),
          defaultBotId: state.defaultBotId
        }
      ]
    : []
}

/** The linked user an installation's row names: the first linked one that sees it. */
export function gitHubLoginFor(state: ConnectorGitHubState, installationId: string): string | null {
  const accounts = gitHubLinkedAccounts(state)
  return (
    accounts.find((entry) => entry.installations.includes(installationId))?.login ??
    state.account?.login ??
    null
  )
}

/** gh is signed out on the host that answered, so its bots can't act on GitHub as their owner. */
export function ghSignedOut(state: ConnectorGitHubState | null): boolean {
  return state?.gh === 'signed-out'
}

/** Linked, with an installation: a bot turned on for GitHub answers there. */
export function gitHubOn(state: ConnectorGitHubState): boolean {
  return state.account !== null && state.installations.length > 0
}
