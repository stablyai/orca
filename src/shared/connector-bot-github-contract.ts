// The desktop's reads of the GitHub routes; the cloud's side lands with them (plan G3).
// Every route acts as the caller's Orca account: confirm and set-default touch only that account's
// own link and default, and a link token is single use.
import * as z from 'zod'
import type { GitHubPeopleScope } from './bots/github-people-scope'

/** How people ask a bot on GitHub: "@orca-bots ranger …" in an issue or pull request comment. */
export const GITHUB_BOT_MENTION = '@orca-bots'

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

/** One GitHub user the Orca account is linked as; each counts as the owner. */
const GitHubLinkedAccount = GitHubUser.extend({
  /** The ids of the installations this user can see. */
  installations: z.array(GitHubId),
  /** Who takes this user's requests when a comment names none; null when unset. */
  defaultBotId: z.string().nullable()
})
export type ConnectorGitHubLinkedAccount = z.infer<typeof GitHubLinkedAccount>

// GET `${github}/state`: the GitHub users this Orca account is linked as, and the Orca app's
// installations they can see.
export const ConnectorGitHubState = z.object({
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

/** `bots.github.people`: the people the Add picker lists, read once per open through the host's own
 *  gh and filtered as the owner types. These are who the chosen reads returned (repositories'
 *  assignable users, organizations' members), not a statement about who has access. */
export type BotGitHubRoster =
  | {
      status: 'read'
      people: { id: string; login: string; name: string | null }[]
      /** Which kinds of source were read and contributed: repositories (listed, or a person's own),
       *  organizations (their member lists). */
      from: { repositories: boolean; organizations: boolean }
      /** Every chosen read came back whole: no source failed or lost entries. It does not mean
       *  everyone who can reach those repositories was listed. */
      complete: boolean
      /** Some connected repositories or accounts were left out on purpose (past the scope's caps,
       *  or not a readable name): not a failure, but not everything either. */
      omitted: boolean
      /** Reads that stopped at their fixed size, whatever the owner types: a repository's first
       *  GITHUB_PEOPLE_PER_SOURCE people, an organization's first GITHUB_PEOPLE_PER_SOURCE
       *  members, a person's first GITHUB_PERSONAL_REPOSITORIES repositories. */
      cut: { people: boolean; members: boolean; repositories: boolean }
      /** When the read started (epoch ms, the host's clock). */
      readAt: number
      /** This answer is an earlier read reused: a host reads once per app run. */
      reused: boolean
      /** What the read was made for: the scope it read, and the linked GitHub login the asking
       *  picker had then (null when it had none). A picker whose own differs treats the list as
       *  historical: its sources and absences say nothing about the current repos or account. */
      readFor: { scope: GitHubPeopleScope; owner: string | null }
      /** The GitHub account gh read every source as, from that same call; absent when unknown.
       *  Which gh binary or runtime ran it (native, or a fallback) isn't recorded. */
      searchedAs?: string
    }
  /** No source could be read. `spent`: a read ran (or may have started a gh process) and no
   *  later read runs in this app run of the host; false when the scope held nothing readable, so
   *  no gh ran and nothing was used up. */
  | { status: 'unavailable'; spent: boolean }
  | { status: 'exact-only' }

/** People per repository or organization a roster read returns. */
export const GITHUB_PEOPLE_PER_SOURCE = 100
/** A person's own repositories read when the app is on their whole account, most recent first. */
export const GITHUB_PERSONAL_REPOSITORIES = 5

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

/** Linked, with an installation: a bot turned on for GitHub answers there. */
export function gitHubOn(state: ConnectorGitHubState): boolean {
  return state.account !== null && state.installations.length > 0
}
