// @vitest-environment happy-dom
// How often the Add picker's GitHub search composes a whole answer: once for each new piece of
// evidence a query consumes (list, username check, the picker's record of checks), not once per
// path that hears about it. Counted at the composer itself; every login and id is synthetic.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotGitHubRoster,
  ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { BotWhoCanAskPicker } from '../BotWhoCanAskPicker'
import { WhoCanAskIdentityLedger } from '../who-can-ask-identity-ledger'
import { ROSTER_WAIT_MS, gitHubWhoCanAskSession } from './github-who-can-ask-session'
import type * as Found from './github-who-can-ask-found'

// Every completed composition, by query; `after` runs once, right after the next one completes.
type Composer = { queries: string[]; after: ((query: string) => void) | null }
const composer: Composer = vi.hoisted((): Composer => ({ queries: [], after: null }))
vi.mock('./github-who-can-ask-found', async (importOriginal) => {
  const actual = await importOriginal<typeof Found>()
  return {
    ...actual,
    gitHubWhoCanAskAnswer: (...args: Parameters<typeof actual.gitHubWhoCanAskAnswer>) => {
      const answer = actual.gitHubWhoCanAskAnswer(...args)
      composer.queries.push(args[0].query)
      const after = composer.after
      composer.after = null
      after?.(args[0].query)
      return answer
    }
  }
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Atlas', members: [] } as unknown as Bot
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: echoes the English default like i18next does with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))) as never

type Users = BotSlackResult<ConnectorGitHubUsersResponse>
type People = BotSlackResult<BotGitHubRoster>
const team: People = {
  ok: true,
  value: {
    status: 'read',
    people: [{ id: '2', login: 'brennanb2025', name: 'Brennan Benson' }],
    from: { repositories: true, organizations: false },
    complete: true,
    omitted: false,
    cut: { people: false, members: false, repositories: false },
    readAt: 0,
    reused: false,
    readFor: { scope: { repositories: ['acme/web'], owners: [], more: false }, owner: 'o' }
  }
}
const unreached: People = { ok: false, error: 'network' }
const found = (id: string, name: string): Users => ({
  ok: true,
  value: { members: [{ id, name }], complete: true }
})
const failed: Users = { ok: false, error: 'network' }
const scope = { repositories: ['acme/web'], owners: [], more: false }

/** Compositions of `query` since `from`. */
const composedFor = (query: string, from = 0): number =>
  composer.queries.slice(from).filter((entry) => entry === query).length

/** The picker on sessions that share its ledger; list reads and username checks wait to be
 *  answered, oldest first, unless `people` answers on its own. */
function picker(people?: () => Promise<People>) {
  const lists: ((value: People) => void)[] = []
  const lookups: { query: string; resolve: (value: Users) => void }[] = []
  const readList = vi.fn(people ?? (() => new Promise<People>((resolve) => lists.push(resolve))))
  const users = vi.fn(
    ({ query }: { query: string }) =>
      new Promise<Users>((resolve) => lookups.push({ query, resolve }))
  )
  const serviceFor = (context: string): BotWhoCanAskService => ({
    listed: () => [],
    stamp: { source: 'github' },
    max: 50,
    search: () => Promise.resolve({ ok: false, error: 'unused' }),
    begin: (ledger) =>
      gitHubWhoCanAskSession(
        { people: readList, users },
        { scope, ownerLogin: context, producer: 'local', t },
        ledger
      ),
    errorMessage: (code) => code,
    searchPlaceholder: 'Search by name or username',
    peopleHeading: 'People on GitHub',
    outsideHeading: 'Elsewhere on GitHub',
    noMatch: (query) => ({ title: `No one found for ${query}`, detail: '' }),
    ownerId: null,
    ownerName: null,
    kind: 'github',
    connector: 'GitHub',
    workspace: null,
    outsiders: null,
    notYet: ''
  })
  const view = render(
    <BotWhoCanAskPicker bot={bot} service={serviceFor('o')} owner="You" onPicked={vi.fn()} />
  )
  const box = (): HTMLElement => screen.getByPlaceholderText('Search by name or username')
  return {
    people: readList,
    users,
    view,
    /** Changes the query (no wait). */
    change: (value: string) => fireEvent.change(box(), { target: { value } }),
    wait: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)),
    landList: async (value: People) => {
      await act(async () => {
        lists.shift()?.(value)
        await vi.advanceTimersByTimeAsync(0)
      })
    },
    answer: async (query: string, value: Users) => {
      await act(async () => {
        const index = lookups.findIndex((lookup) => lookup.query === query)
        lookups.splice(index, 1)[0]?.resolve(value)
        await vi.advanceTimersByTimeAsync(0)
      })
    },
    /** Resolves the oldest lookup of `query` without waiting. */
    answerNow: (query: string, value: Users) => {
      const index = lookups.findIndex((lookup) => lookup.query === query)
      lookups.splice(index, 1)[0]?.resolve(value)
    },
    retry: async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await vi.advanceTimersByTimeAsync(0)
      })
    },
    /** Another context: a new session on the same picker open. */
    retire: () =>
      view.rerender(
        <BotWhoCanAskPicker bot={bot} service={serviceFor('o2')} owner="You" onPicked={vi.fn()} />
      )
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  composer.queries = []
  composer.after = null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('one composition per new piece of evidence', () => {
  it('a whole Try again of a failed username check, with the list read: one composition', async () => {
    const view = picker(async () => team)
    view.change('brennan')
    await view.wait(300)
    await view.answer('brennan', failed)
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    const from = composer.queries.length
    await view.retry()
    await view.answer('brennan', found('9', 'brennan'))
    expect(composedFor('brennan', from)).toBe(1)
    expect(screen.getByText('brennan')).toBeTruthy()
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(screen.queryByText(/Username check failed\./)).toBeNull()
    // Only the failed half went out again.
    expect(view.users).toHaveBeenCalledTimes(2)
    expect(view.people).toHaveBeenCalledOnce()
  })

  it('a whole Try again that recovers an unanswered list: one composition', async () => {
    const view = picker()
    view.change('brennan')
    await view.wait(300)
    await view.answer('brennan', found('9', 'brennan'))
    await view.landList(unreached)
    expect(screen.getByText(/Couldn’t get the repo list\./)).toBeTruthy()
    const from = composer.queries.length
    await view.retry()
    await view.landList(team)
    expect(composedFor('brennan', from)).toBe(1)
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(screen.getByText('brennan')).toBeTruthy()
    expect(view.people).toHaveBeenCalledTimes(2)
    expect(view.users).toHaveBeenCalledOnce()
  })

  it('the first search waiting on the list, which lands before its deadline: one composition', async () => {
    const view = picker()
    await view.wait(300)
    await view.landList(team)
    expect(composedFor('')).toBe(1)
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(view.people).toHaveBeenCalledOnce()
    expect(view.users).not.toHaveBeenCalled()
  })

  it('a username check settling first, then the list before the deadline: one composition of both', async () => {
    const view = picker()
    view.change('brennan')
    await view.wait(300)
    // The check lands first; the search asked again for it waits on the list too.
    await view.answer('brennan', found('9', 'brennan'))
    expect(composedFor('brennan')).toBe(0)
    await view.landList(team)
    expect(composedFor('brennan')).toBe(1)
    expect(screen.getByText('brennan')).toBeTruthy()
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(view.people).toHaveBeenCalledOnce()
    expect(view.users).toHaveBeenCalledOnce()
  })
})

describe('what still composes again', () => {
  it('list rows first, then the username check: two compositions, the early rows painted', async () => {
    const view = picker(async () => team)
    // The list is read before this query is asked.
    await view.wait(300)
    view.change('brennan')
    await view.wait(300)
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(screen.queryByText('brennan')).toBeNull()
    expect(composedFor('brennan')).toBe(1)
    await view.answer('brennan', found('9', 'brennan'))
    expect(composedFor('brennan')).toBe(2)
    expect(screen.getByText('brennan')).toBeTruthy()
  })

  it('the deadline passing before the list lands: one answer without it, one with it', async () => {
    const view = picker()
    await view.wait(300 + ROSTER_WAIT_MS)
    expect(composedFor('')).toBe(1)
    expect(screen.queryByText('brennanb2025')).toBeNull()
    await view.landList(team)
    expect(composedFor('')).toBe(2)
    expect(screen.getByText('brennanb2025')).toBeTruthy()
  })

  it('a retired session’s check landing after a composition, before it paints: ranked again once', async () => {
    const view = picker(async () => team)
    view.change('brennan')
    await view.wait(300)
    // A new context: a new session; the first session's check is still out.
    view.retire()
    await view.wait(300)
    view.change('Brennan B')
    // Right after the next composition, before it paints, the old check finds id 2 renamed.
    composer.after = () => view.answerNow('brennan', found('2', 'brennan'))
    const from = composer.queries.length
    await view.wait(300)
    expect(composedFor('Brennan B', from)).toBe(2)
    // The newer evidence painted last: the list's row under its new login.
    expect(screen.queryByText('brennanb2025')).toBeNull()
    expect(screen.getByText('brennan')).toBeTruthy()
    expect(view.people).toHaveBeenCalledTimes(2)
  })

  // Both queries wait on the list: the current one composes once when it lands.
  it('a superseded query never paints, and the current one paints the list', async () => {
    const view = picker()
    view.change('brennan')
    await view.wait(300)
    view.change('brenda')
    await view.wait(300)
    await view.landList(team)
    expect(composedFor('brenda')).toBe(1)
    expect(screen.queryByText('brennanb2025')).toBeNull()
    // The old query's check landing later changes nothing on screen.
    await view.answer('brennan', found('9', 'brennan'))
    expect(screen.queryByText('brennan')).toBeNull()
    await view.answer('brenda', { ok: true, value: { members: [], complete: true } })
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.getByPlaceholderText('Search by name or username')).toHaveProperty(
      'value',
      'brenda'
    )
    expect(view.users.mock.calls.map(([args]) => args.query)).toEqual(['brennan', 'brenda'])
  })

  it('a picker closed while its search waits: that search composes once, and nothing asks again', async () => {
    const view = picker()
    view.change('brennan')
    await view.wait(300)
    view.view.unmount()
    await view.landList(team)
    expect(composedFor('brennan')).toBe(1)
    expect(view.people).toHaveBeenCalledOnce()
    expect(view.users).toHaveBeenCalledOnce()
  })
})

describe('a session on its own', () => {
  it('tells its listener once when the list lands, and answers an unchanged search from what it composed', async () => {
    let land = (_value: People): void => {}
    const people = vi.fn(() => new Promise<People>((resolve) => (land = resolve)))
    const users = vi.fn(async () => found('9', 'brennan'))
    const ledger = new WhoCanAskIdentityLedger()
    const session = gitHubWhoCanAskSession(
      { people, users },
      { scope, ownerLogin: 'o', producer: 'local', t },
      ledger
    )
    const told = vi.fn()
    const stop = session.onUpdate?.(told)
    const first = session.search('')
    land(team)
    const answer = await first
    expect(told).toHaveBeenCalledOnce()
    expect(await session.search('')).toBe(answer)
    expect(composedFor('')).toBe(1)
    // A check settling elsewhere in this open is newer evidence: composed again.
    ledger.settle(ledger.issue('someone'), 'someone', [])
    expect(await session.search('')).not.toBe(answer)
    expect(composedFor('')).toBe(2)
    stop?.()
    expect(people).toHaveBeenCalledOnce()
    expect(users).not.toHaveBeenCalled()
  })
})

describe('what the clock changes in a later answer', () => {
  const HOUR = 60 * 60_000
  /** A read list with one matching person, read at `readAt`; `reused` from an earlier picker
   *  open, read as `viewer` (another gh account than the linked one). */
  const listAt = (readAt: number, reused: boolean, viewer?: string): People => ({
    ok: true,
    value: {
      status: 'read',
      people: [{ id: '5', login: 'sam-k', name: 'Sam K' }],
      from: { repositories: true, organizations: false },
      complete: true,
      omitted: false,
      cut: { people: false, members: false, repositories: false },
      readAt,
      reused,
      readFor: { scope, owner: 'o' },
      ...(viewer ? { searchedAs: viewer } : {})
    }
  })
  // Expected wording, built here from the read time (not by the code under test).
  const timeOf = (at: number): string =>
    new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  const dayOf = (at: number): string =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)
  /** The note's first line (the list's date), whitespace as the screen reads it. */
  const note = (): string =>
    (screen.getByText(/^Repo list from /).textContent ?? '').split('\n')[0].replace(/\s+/g, ' ')
  const shows = (text: string): string => text.replace(/\s+/g, ' ')

  // Exact times: only the debounce moves this clock, so each composition's moment is known.
  beforeEach(() => vi.useFakeTimers())

  it('a list read before midnight, searched again just after it: dated by its day', async () => {
    const readAt = new Date(2026, 10, 20, 23, 50).getTime()
    vi.setSystemTime(readAt)
    const view = picker(async () => listAt(readAt, false))
    view.change('sam')
    await view.wait(300)
    expect(screen.getByText('sam-k')).toBeTruthy()
    expect(note()).toBe(shows(`Repo list from ${timeOf(readAt)}.`))
    // Past midnight; the same search again (a trailing space: the session sees the same query).
    vi.setSystemTime(new Date(2026, 10, 21, 0, 5))
    view.change('sam ')
    await view.wait(300)
    expect(screen.getByText('sam-k')).toBeTruthy()
    expect(note()).toBe(shows(`Repo list from ${dayOf(readAt)}.`))
    expect(view.people).toHaveBeenCalledOnce()
    expect(view.users).toHaveBeenCalledTimes(1)
  })

  it('a reused list past an hour old gets the restart advice; at exactly an hour, not yet', async () => {
    const readAt = new Date(2026, 10, 20, 9, 1).getTime()
    // The search composes when the debounce fires, 250 ms after the change.
    vi.setSystemTime(readAt + 59 * 60_000 - 250)
    const view = picker(async () => listAt(readAt, true, 'viewer-two'))
    view.change('sam')
    await view.wait(300)
    expect(note()).toBe(shows(`Repo list from ${timeOf(readAt)}.`))
    expect(screen.getByText(/Repos read as @viewer-two\./)).toBeTruthy()
    // Exactly an hour old when it composes: still no advice.
    vi.setSystemTime(readAt + HOUR - 250)
    view.change('sam ')
    await view.wait(300)
    expect(note()).toBe(shows(`Repo list from ${timeOf(readAt)}.`))
    // Past the hour: the same row, the same read time and viewer, now with the advice.
    vi.setSystemTime(readAt + HOUR + 60_000 - 250)
    view.change('sam')
    await view.wait(300)
    expect(screen.getByText('sam-k')).toBeTruthy()
    expect(note()).toBe(shows(`Repo list from ${timeOf(readAt)}. Restart Orca to refresh.`))
    expect(screen.getByText(/Repos read as @viewer-two\./)).toBeTruthy()
    expect(view.people).toHaveBeenCalledOnce()
  })

  it('the same search later on the same day, the list still fresh: the answer it composed', async () => {
    const readAt = new Date(2026, 10, 20, 10, 0).getTime()
    vi.setSystemTime(readAt)
    const view = picker(async () => listAt(readAt, false))
    view.change('sam')
    await view.wait(300)
    const from = composedFor('sam')
    vi.setSystemTime(readAt + 30 * 60_000)
    view.change('sam ')
    await view.wait(300)
    expect(composedFor('sam')).toBe(from)
    expect(note()).toBe(shows(`Repo list from ${timeOf(readAt)}.`))
  })
})
