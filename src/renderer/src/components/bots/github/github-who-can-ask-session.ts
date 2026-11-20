import type { Translate } from '@/i18n/use-translate'
import {
  GITHUB_LOGIN_PATTERN,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import type { GitHubPeopleScope } from '../../../../../shared/bots/github-people-scope'
import type { BotWhoCanAskSession } from '../BotWhoCanAskList'
import { gitHubWhoCanAskAnswer, type GitHubRosterState } from './github-who-can-ask-found'

/** How long one keystroke's answer waits for a roster still loading; it then goes out with what
 *  it has, and the session tells its listener when the roster lands. Logical only. */
export const ROSTER_WAIT_MS = 1_500

type Calls = {
  people: (args: { scope: GitHubPeopleScope }) => Promise<BotSlackResult<BotGitHubRoster>>
  users: (args: { query: string }) => Promise<BotSlackResult<ConnectorGitHubUsersResponse>>
}

type Context = {
  scope: GitHubPeopleScope | undefined
  ownerLogin: string | null
  t: Translate
}

type Exact = BotSlackResult<ConnectorGitHubUsersResponse>

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
 *  filters it. The exact-username lookup runs once per username-shaped query; asking again for the
 *  same query (when the roster lands) reuses its answer. */
export function gitHubWhoCanAskSession(
  calls: Calls,
  { scope, ownerLogin, t }: Context
): BotWhoCanAskSession {
  let roster: Promise<GitHubRosterState> | null = null
  let settled: GitHubRosterState | null = null
  // At most one listener, the picker's current query's; cleared once told or when it leaves.
  let listener: (() => void) | null = null
  // The last query's exact lookup: one entry, so asking again never repeats it.
  let lastExact: { login: string; answer: Promise<Exact> } | null = null

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
      const told = listener
      listener = null
      told?.()
      return state
    })
    return roster
  }
  const exactFor = (login: string): Promise<Exact> | null => {
    if (!GITHUB_LOGIN_PATTERN.test(login)) {
      return null
    }
    if (lastExact?.login !== login) {
      lastExact = { login, answer: calls.users({ query: login }) }
    }
    return lastExact.answer
  }

  return {
    search: async (query) => {
      const loading = load()
      const exact = exactFor(query.trim().replace(/^@/, ''))
      const early = settled ?? (await settledWithin(loading, ROSTER_WAIT_MS))
      const exactAnswer = exact ? await exact : null
      // The roster may have landed while the exact lookup was still on its way.
      const now = settled ?? early
      return gitHubWhoCanAskAnswer(
        { roster: now ?? { status: 'loading' }, exact: exactAnswer, query, ownerLogin },
        t
      )
    },
    onUpdate: (next) => {
      if (settled) {
        return () => {}
      }
      listener = next
      return () => {
        if (listener === next) {
          listener = null
        }
      }
    }
  }
}
