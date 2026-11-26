import type { Translate } from '@/i18n/use-translate'
import {
  GITHUB_LOGIN_PATTERN,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import type { GitHubPeopleScope } from '../../../../../shared/bots/github-people-scope'
import type { BotWhoCanAskSession } from '../BotWhoCanAskList'
import { WhoCanAskIdentityLedger } from '../who-can-ask-identity-ledger'
import { gitHubWhoCanAskAnswer, type GitHubRosterState } from './github-who-can-ask-found'

/** How long one keystroke's answer waits for a roster still loading; it then goes out with what
 *  it has, and the session tells its listener when the roster lands. Logical only. */
export const ROSTER_WAIT_MS = 1_500

/** What GitHub search matches by: what was typed, without a leading @. */
export const gitHubSearchTerm = (query: string): string => query.trim().replace(/^@/, '')

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

/** One picker open: the roster is asked for once, on the first search, and every keystroke after
 *  filters it. The exact-username lookup runs once per username-shaped query; asking again for the
 *  same query (when the roster or the lookup lands) reuses its answer.
 *
 *  What a session holds, and until when:
 *  - the roster request: one per session; its answer arrives when the host answers (bounded by the
 *    host's slot rules), whether or not the picker is still open;
 *  - roster waiters: one per search still within ROSTER_WAIT_MS, removed at that deadline or when
 *    the roster lands, whichever comes first, so nothing waits on the roster past it;
 *  - one update listener (the picker's current query), replaced by the next, removed by its
 *    unsubscribe (query change, close); told when the roster lands and when the current lookup
 *    settles;
 *  - the last query's exact lookup: it settles on the cloud call's own bounds (shared token mint,
 *    request timeout, one renewal on 401), independently of the roster. With the list read, a
 *    search answers with the list's rows while it is out, and the listener hears when it lands.
 *    Every lookup, a replaced query's too, goes into the picker's ledger and tells the listener,
 *    since what it says about a login can hide or rename the current rows. */
export function gitHubWhoCanAskSession(
  calls: Calls,
  { scope, ownerLogin, linkedLogins, producer, t }: Context,
  // The picker open's record of every check, kept across its sessions (context changes); every
  // lookup this session asks goes in, whether or not its query still paints.
  ledger: WhoCanAskIdentityLedger = new WhoCanAskIdentityLedger()
): BotWhoCanAskSession & { readonly waiters: number } {
  let roster: Promise<GitHubRosterState> | null = null
  let settled: GitHubRosterState | null = null
  // At most one listener, the picker's current query's; cleared when it leaves.
  let listener: (() => void) | null = null
  const tell = (): void => listener?.()
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
  let lastExact: {
    login: string
    answer: Promise<Exact>
    settled: Exact | null
  } | null = null
  // Set by an asked-for retry: the next search waits for the whole answer, list and lookup (the
  // picker keeps its rows on screen meanwhile), rather than going out at ROSTER_WAIT_MS.
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
      if (state.status === 'read') {
        ledger.learnNames(state.people)
      }
      // Each waiter removes itself as it runs; a Set allows that during iteration.
      for (const done of waiting) {
        done(state)
      }
      tell()
      return state
    })
    return roster
  }
  const exactFor = (login: string): typeof lastExact => {
    if (!GITHUB_LOGIN_PATTERN.test(login)) {
      return null
    }
    if (lastExact?.login !== login) {
      const entry: NonNullable<typeof lastExact> = {
        login,
        answer: calls.users({ query: login }),
        settled: null
      }
      const seq = ledger.issue(login)
      void entry.answer.then((answer) => {
        ledger.settle(seq, login, answer.ok ? answer.value.members : null)
        entry.settled = answer
        // Even a replaced query's lookup can change who the current rows are.
        tell()
      })
      lastExact = entry
    }
    return lastExact
  }

  return {
    get waiters() {
      return waiting.size
    },
    search: async (query) => {
      const loading = load()
      const exact = exactFor(gitHubSearchTerm(query))
      const waitWhole = patient
      patient = false
      const early = settled ?? (await (waitWhole ? loading : settledWithin(ROSTER_WAIT_MS)))
      // With the list read, its rows go out now; the lookup joins them when it lands.
      const exactAnswer =
        exact === null
          ? null
          : !waitWhole && (settled ?? early)?.status === 'read'
            ? (exact.settled ?? 'pending')
            : await exact.answer
      // The roster may have landed while the exact lookup was still on its way.
      const now = settled ?? early
      return gitHubWhoCanAskAnswer(
        {
          roster: now ?? { status: 'loading' },
          exact: exactAnswer,
          query,
          ownerLogin,
          linkedLogins,
          scope,
          producer,
          identity: (id, login) => ledger.identity(id, login)
        },
        t
      )
    },
    // Only what failed is asked again: a list request the host never answered (one new request,
    // shared by every search until it settles), and a failed exact lookup. Nothing runs until the
    // picker searches again.
    retry: () => {
      if (settled?.status === 'unreached') {
        roster = null
        settled = null
      }
      if (lastExact?.settled && !lastExact.settled.ok) {
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
