import type { Translate } from '@/i18n/use-translate'
import {
  GITHUB_LOGIN_PATTERN,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import type { GitHubPeopleScope } from '../../../../../shared/bots/github-people-scope'
import type { BotWhoCanAskIdentityUpdate, BotWhoCanAskSession } from '../BotWhoCanAskList'
import {
  gitHubWhoCanAskAnswer,
  supersededGitHubPeople,
  type GitHubRosterState
} from './github-who-can-ask-found'

/** How long one keystroke's answer waits for a roster still loading; it then goes out with what
 *  it has, and the session tells its listener when the roster lands. Logical only. */
export const ROSTER_WAIT_MS = 1_500

type Calls = {
  people: (args: {
    scope: GitHubPeopleScope
    owner: string | null
  }) => Promise<BotSlackResult<BotGitHubRoster>>
  users: (args: { query: string }) => Promise<BotSlackResult<ConnectorGitHubUsersResponse>>
}

type Context = {
  scope: GitHubPeopleScope | undefined
  /** The first linked login: one list is read for every row, so its key can't follow the row. */
  ownerLogin: string | null
  /** Every linked login; gh reading as any of them is not called out. */
  linkedLogins?: readonly string[]
  /** Where the bot runs: this computer's Orca, or another's (restart advice names it). */
  producer: 'local' | 'remote'
  t: Translate
}

type Exact = BotSlackResult<ConnectorGitHubUsersResponse>
type ExactLookup = {
  login: string
  answer: Promise<Exact>
  settled: boolean
  failed: boolean
  /** Whether an early answer went out without it. */
  refresh: boolean
}

/** One picker open: the roster is asked for once, on the first search, and every keystroke after
 *  filters it. The exact-username lookup runs once per username-shaped query; asking again for the
 *  same query (when the roster lands) reuses its answer.
 *
 *  What a session holds, and until when:
 *  - the roster request: one per session; its answer arrives when the host answers (bounded by the
 *    host's slot rules), whether or not the picker is still open;
 *  - roster waiters: one per search still within ROSTER_WAIT_MS, removed at that deadline or when
 *    the roster lands, whichever comes first, so nothing waits on the roster past it;
 *  - one update listener for the current query, removed on query change or close; the roster and
 *    an exact lookup omitted from an early answer can each request a refresh. Settled lookups can
 *    also correct a draft identity without repainting the results of an old query;
 *  - the last query's exact lookup: it settles on the cloud call's own bounds (shared token mint,
 *    request timeout, one renewal on 401), independently of the roster; the picker drops its
 *    answer once the query changes or the picker closes. */
export function gitHubWhoCanAskSession(
  calls: Calls,
  { scope, ownerLogin, linkedLogins, producer, t }: Context
): BotWhoCanAskSession & { readonly waiters: number } {
  let roster: Promise<GitHubRosterState> | null = null
  let settled: GitHubRosterState | null = null
  // At most one listener, the picker's current query's; cleared when it leaves.
  let listener: ((refresh: boolean, identities?: BotWhoCanAskIdentityUpdate) => void) | null = null
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
  // The last valid query's exact lookup: one entry, so asking again for that same query never
  // repeats it (a failure included) unless the owner asks to retry; a different query is its own.
  let lastExact: ExactLookup | null = null
  // Set by an asked-for retry: the next search waits for the whole list answer (the picker keeps
  // its rows on screen meanwhile) rather than going out at ROSTER_WAIT_MS.
  let patient = false

  const load = (): Promise<GitHubRosterState> => {
    roster ??= (
      scope === undefined
        ? Promise.resolve<GitHubRosterState>({ status: 'skipped' })
        : scope.repositories.length + scope.owners.length === 0
          ? Promise.resolve<GitHubRosterState>({ status: 'none' })
          : // The call itself failing (the host unreachable) leaves this session without a list
            // until the owner asks again (retry); the host still keeps its one read per app run.
            calls.people({ scope, owner: ownerLogin }).then(
              (result): GitHubRosterState => (result.ok ? result.value : { status: 'unreached' }),
              (): GitHubRosterState => ({ status: 'unreached' })
            )
    ).then((state) => {
      settled = state
      // Each waiter removes itself as it runs; a Set allows that during iteration.
      for (const done of waiting) {
        done(state)
      }
      listener?.(true)
      return state
    })
    return roster
  }
  const exactFor = (login: string): ExactLookup | null => {
    if (!GITHUB_LOGIN_PATTERN.test(login)) {
      return null
    }
    if (lastExact?.login !== login) {
      const entry = {
        login,
        answer: calls.users({ query: login }),
        settled: false,
        failed: false,
        refresh: false
      }
      void entry.answer.then((answer) => {
        entry.settled = true
        entry.failed = !answer.ok
        const refresh = entry.refresh && lastExact === entry
        const current = answer.ok ? answer.value.members : []
        if (settled?.status === 'read' && current.length > 0) {
          listener?.(refresh, {
            current,
            superseded: supersededGitHubPeople(settled.people, current)
          })
        } else if (refresh) {
          listener?.(true)
        }
      })
      lastExact = entry
    }
    return lastExact
  }

  const answer = (query: string, roster: GitHubRosterState, exact: Exact | null) =>
    gitHubWhoCanAskAnswer({ roster, exact, query, ownerLogin, linkedLogins, scope, producer }, t)

  return {
    get waiters() {
      return waiting.size
    },
    search: async (query) => {
      const loading = load()
      const exact = exactFor(query.trim().replace(/^@/, ''))
      const waitWhole = patient
      patient = false
      const early = settled ?? (await (waitWhole ? loading : settledWithin(ROSTER_WAIT_MS)))
      // People the list already matches go out now, without waiting on the cloud; the exact
      // lookup then tells the listener, which asks again for the fuller answer. An asked-for
      // retry waits for the whole answer instead, and a list with no match waits too, so an
      // empty result never claims the username check ran.
      if (exact && !exact.settled && !waitWhole && early?.status === 'read') {
        const partial = answer(query, early, null)
        if (partial.ok && partial.value.members.length > 0) {
          exact.refresh = true
          return partial
        }
      }
      const exactAnswer = exact ? await exact.answer : null
      // The roster may have landed while the exact lookup was still on its way.
      return answer(query, settled ?? early ?? { status: 'loading' }, exactAnswer)
    },
    // Only what failed is asked again: a list request the host never answered (one new request,
    // shared by every search until it settles), and a failed exact lookup. Nothing runs until the
    // picker searches again.
    retry: () => {
      if (settled?.status === 'unreached') {
        roster = null
        settled = null
      }
      if (lastExact?.failed) {
        lastExact = null
      }
      patient = true
    },
    onUpdate: (next) => {
      listener = next
      return () => {
        if (listener === next) {
          listener = null
        }
      }
    }
  }
}
