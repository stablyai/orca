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

/** One picker open: the roster is asked for once, on the first search, and every keystroke after
 *  filters it. The exact-username lookup runs once per username-shaped query; asking again for the
 *  same query (when the roster lands) reuses its answer.
 *
 *  What a session holds, and until when:
 *  - the roster request: one per session; its answer arrives when the host answers (bounded by the
 *    host's slot rules), whether or not the picker is still open;
 *  - roster waiters: one per search still within ROSTER_WAIT_MS, removed at that deadline or when
 *    the roster lands, whichever comes first, so nothing waits on the roster past it;
 *  - one update listener (the picker's current query), replaced by the next, removed by its
 *    unsubscribe (query change, close) or once told;
 *  - the last query's exact lookup: it settles on the cloud call's own bounds (shared token mint,
 *    request timeout, one renewal on 401), independently of the roster; the picker drops its
 *    answer once the query changes or the picker closes. */
export function gitHubWhoCanAskSession(
  calls: Calls,
  { scope, ownerLogin, t }: Context
): BotWhoCanAskSession & { readonly waiters: number } {
  let roster: Promise<GitHubRosterState> | null = null
  let settled: GitHubRosterState | null = null
  // At most one listener, the picker's current query's; cleared once told or when it leaves.
  let listener: (() => void) | null = null
  // Searches waiting (up to ROSTER_WAIT_MS) for a roster still loading; each removes itself.
  const waiting = new Set<(state: GitHubRosterState | null) => void>()
  const settledWithin = (ms: number): Promise<GitHubRosterState | null> =>
    new Promise((resolve) => {
      const done = (state: GitHubRosterState | null): void => {
        clearTimeout(timer)
        waiting.delete(done)
        resolve(state)
      }
      const timer = setTimeout(() => done(null), ms)
      waiting.add(done)
    })
  // The last query's exact lookup: one entry, so asking again never repeats it.
  let lastExact: { login: string; answer: Promise<Exact> } | null = null

  const load = (): Promise<GitHubRosterState> => {
    roster ??= (
      scope === undefined
        ? Promise.resolve<GitHubRosterState>({ status: 'skipped' })
        : scope.repositories.length + scope.owners.length === 0
          ? Promise.resolve<GitHubRosterState>({ status: 'none' })
          : // The call itself failing (the host unreachable) says nothing about a gh child; the
            // next open asks the host again, which still keeps to its one read per app run.
            calls.people({ scope }).then(
              (result): GitHubRosterState =>
                result.ok ? result.value : { status: 'unavailable', retry: 'reopen' },
              (): GitHubRosterState => ({ status: 'unavailable', retry: 'reopen' })
            )
    ).then((state) => {
      settled = state
      // Each waiter removes itself as it runs; a Set allows that during iteration.
      for (const done of waiting) {
        done(state)
      }
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
    get waiters() {
      return waiting.size
    },
    search: async (query) => {
      void load()
      const exact = exactFor(query.trim().replace(/^@/, ''))
      const early = settled ?? (await settledWithin(ROSTER_WAIT_MS))
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
