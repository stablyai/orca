// The desktop's reads of the GitHub routes; the cloud's side lands with them (plan G3).
// Every route acts as the caller's Orca account: confirm and set-default touch only that account's
// own link and default, and a link token is single use.
import * as z from 'zod'

/** How people ask a bot on GitHub: "@orca-ide ranger …" in an issue or pull request comment. */
export const GITHUB_BOT_MENTION = '@orca-ide'

// Exactly the cloud's (connector-contract), so both sides accept the same ids and logins.
/** GitHub's numeric ids (users, installations), as strings. */
export const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const GitHubId = z.string().regex(GITHUB_ID_PATTERN)
/** A GitHub user or organization name, Enterprise Managed Users' `_shortcode` included. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/
const GitHubLogin = z.string().regex(GITHUB_LOGIN_PATTERN)

const GitHubUser = z.object({
  /** The only thing the cloud matches a comment's author on. */
  userId: GitHubId,
  login: GitHubLogin
})

// GET `${github}/state`: the GitHub user this Orca account is linked as, and the Orca app's
// installations that user can see. A bot turned on for GitHub answers in each installation.
export const ConnectorGitHubState = z.object({
  /** GitHub's install page for the Orca app, signed for this account. */
  installUrl: z.string().url(),
  /** Null until the owner connects GitHub from Orca. */
  account: GitHubUser.nullable(),
  installations: z.array(
    z.object({
      installationId: GitHubId,
      /** The user or organization the app is installed on. */
      accountLogin: GitHubLogin,
      /** Null when the app may use every repository of that account. */
      repositories: z.array(z.object({ fullName: z.string().min(1) })).nullable()
    })
  ),
  /** The bot that takes the owner's requests when a comment names none; null when unset. */
  defaultBotId: z.string().nullable()
})
export type ConnectorGitHubState = z.infer<typeof ConnectorGitHubState>
export type ConnectorGitHubInstallation = ConnectorGitHubState['installations'][number]

// GET `${github}/users?q=<username>`: the GitHub user with that username, found by exact match, as
// {id: numeric user id, name: login}; complete as for Slack's.
export const ConnectorGitHubUsersResponse = z.object({
  members: z.array(z.object({ id: GitHubId, name: GitHubLogin })),
  complete: z.boolean()
})
export type ConnectorGitHubUsersResponse = z.infer<typeof ConnectorGitHubUsersResponse>

/** The desktop's own code for a cloud with GitHub off (every GitHub route answers 404). */
export const BOT_GITHUB_OFF = 'github_off'

/** Linked, with an installation: a bot turned on for GitHub answers there. */
export function gitHubOn(state: ConnectorGitHubState): boolean {
  return state.account !== null && state.installations.length > 0
}
