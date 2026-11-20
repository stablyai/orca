import type { Translate } from '@/i18n/use-translate'
import {
  GITHUB_LOGIN_PATTERN,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import type { GitHubPeopleScope } from '../../../../../shared/bots/github-people-scope'
import type { BotWhoCanAskFound } from '../BotWhoCanAskList'
import { gitHubWhoCanAskAnswer, type GitHubRosterState } from './github-who-can-ask-found'

/** How long one keystroke's answer waits for a roster still loading; it then goes out with what
 *  it has, and the picker asks again when the roster arrives. Logical only: nothing is stopped. */
export const ROSTER_WAIT_MS = 1_500

type Calls = {
  people: (args: { scope: GitHubPeopleScope }) => Promise<BotSlackResult<BotGitHubRoster>>
  users: (args: { query: string }) => Promise<BotSlackResult<ConnectorGitHubUsersResponse>>
}

type Context = {
  scope: GitHubPeopleScope | undefined
  ownerLogin: string | null
  hostName: string | null
  t: Translate
}

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/** One picker open: the roster is asked for once, on the first search, and every keystroke after
 *  filters it; the exact-username lookup runs per keystroke as it always has. */
export function gitHubWhoCanAskSession(
  calls: Calls,
  { scope, ownerLogin, hostName, t }: Context
): (query: string) => Promise<BotSlackResult<BotWhoCanAskFound>> {
  let roster: Promise<GitHubRosterState> | null = null
  let settled: GitHubRosterState | null = null
  const load = (): Promise<GitHubRosterState> => {
    roster ??= (
      scope === undefined
        ? Promise.resolve<GitHubRosterState>({ status: 'skipped' })
        : scope.repositories.length + scope.owners.length === 0
          ? Promise.resolve<GitHubRosterState>({ status: 'none' })
          : calls.people({ scope }).then(
              (result): GitHubRosterState => (result.ok ? result.value : { status: 'unavailable' }),
              (): GitHubRosterState => ({ status: 'unavailable' })
            )
    ).then((state) => {
      settled = state
      return state
    })
    return roster
  }
  return async (query) => {
    const loading = load()
    const login = query.trim().replace(/^@/, '')
    const exact = GITHUB_LOGIN_PATTERN.test(login) ? calls.users({ query: login }) : null
    const now = settled ?? (await settledWithin(loading, ROSTER_WAIT_MS))
    return gitHubWhoCanAskAnswer(
      {
        roster: now ?? { status: 'loading' },
        exact: exact ? await exact : null,
        query,
        ownerLogin,
        hostName,
        ...(now ? {} : { pending: loading })
      },
      t
    )
  }
}
