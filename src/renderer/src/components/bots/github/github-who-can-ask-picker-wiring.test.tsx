// @vitest-environment happy-dom
// The Add picker driving a real GitHub session: what the owner sees while the roster loads and
// after it lands, and what goes over the wire.
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
import { ROSTER_WAIT_MS, gitHubWhoCanAskSession } from './github-who-can-ask-session'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Atlas', members: [] } as unknown as Bot
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: echoes the English default like i18next does with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))) as never

const roster: BotGitHubRoster = {
  status: 'read',
  people: [{ id: '2', login: 'brennanb2025', name: 'Brennan Benson' }],
  from: { repositories: true, organizations: false },
  complete: true,
  omitted: false,
  cut: { people: false, members: false, repositories: false },
  readAt: 0,
  reused: false,
  readFor: { scope: { repositories: ['stablyai/orca'], owners: [], more: false }, owner: 'owner' }
}
type Users = BotSlackResult<ConnectorGitHubUsersResponse>

function setUp() {
  let land = (_value: BotSlackResult<BotGitHubRoster>): void => {}
  const people = vi.fn(
    () =>
      new Promise<BotSlackResult<BotGitHubRoster>>((resolve) => {
        land = resolve
      })
  )
  const users = vi.fn(async ({ query }: { query: string }): Promise<Users> => ({
    ok: true,
    value: { members: query === 'brennan' ? [{ id: '9', name: 'brennan' }] : [], complete: true }
  }))
  const scope = { repositories: ['acme/web'], owners: [], more: false }
  const searches = vi.fn()
  const begin = () => {
    const session = gitHubWhoCanAskSession(
      { people, users },
      { scope, ownerLogin: 'o', producer: 'local', t }
    )
    return {
      ...session,
      search: (query: string) => {
        searches(query)
        return session.search(query)
      }
    }
  }
  const service: BotWhoCanAskService = {
    listed: () => [],
    stamp: { source: 'github' },
    max: 50,
    search: (query) => begin().search(query),
    begin,
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
  }
  return {
    service,
    people,
    users,
    searches,
    land: (value: BotSlackResult<BotGitHubRoster>) => land(value)
  }
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the Add picker on a GitHub session', () => {
  it('shows the exact match while the roster loads, then fills in place without asking again', async () => {
    const { service, people, users, searches, land } = setUp()
    render(<BotWhoCanAskPicker bot={bot} service={service} owner="You" onPicked={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'brennan' }
    })
    await act(() => vi.advanceTimersByTimeAsync(300 + ROSTER_WAIT_MS))
    expect(screen.getByText('Repos still loading')).toBeTruthy()
    expect(screen.queryByText(/No one found/)).toBeNull()

    const searching = vi.fn()
    const observer = new MutationObserver(() => {
      if (screen.queryByText('Searching…')) {
        searching()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    await act(async () => {
      land({ ok: true, value: roster })
      await vi.advanceTimersByTimeAsync(0)
    })
    observer.disconnect()
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(screen.getByText('Not found in your repos')).toBeTruthy()
    // The rows never blanked to "Searching…", and the exact lookup ran once for this query.
    expect(searching).not.toHaveBeenCalled()
    expect(users).toHaveBeenCalledOnce()
    expect(people).toHaveBeenCalledOnce()
    // ...and the picker asked its session once more, for the same query.
    expect(searches.mock.calls.map(([query]) => query).slice(-2)).toEqual(['brennan', 'brennan'])
  })

  it('stops listening when the picker closes', async () => {
    const { service, searches, land } = setUp()
    const { unmount } = render(
      <BotWhoCanAskPicker bot={bot} service={service} owner="You" onPicked={vi.fn()} />
    )
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'brennan' }
    })
    await act(() => vi.advanceTimersByTimeAsync(300 + ROSTER_WAIT_MS))
    const asked = searches.mock.calls.length
    unmount()
    land({ ok: true, value: roster })
    await vi.advanceTimersByTimeAsync(0)
    // A closed picker asks nothing more when the roster lands.
    expect(searches).toHaveBeenCalledTimes(asked)
  })

  it('retries a failed username check in place, keeping the query, the picks and the rows', async () => {
    const team: BotGitHubRoster = {
      ...roster,
      people: [
        { id: '2', login: 'brennanb2025', name: 'Brennan Benson' },
        { id: '3', login: 'brenda-q', name: 'Brenda Quinn' }
      ]
    }
    const users = vi
      .fn<(args: { query: string }) => Promise<Users>>()
      .mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockResolvedValue({
        ok: true,
        value: { members: [{ id: '9', name: 'bren' }], complete: true }
      })
    const scope = { repositories: ['acme/web'], owners: [], more: false }
    const begin = () =>
      gitHubWhoCanAskSession(
        { people: async () => ({ ok: true, value: team }), users },
        { scope, ownerLogin: 'o', producer: 'local', t }
      )
    const { service } = setUp()
    const onPicked = vi.fn()
    render(
      <BotWhoCanAskPicker
        bot={bot}
        service={{ ...service, begin, search: (query) => begin().search(query) }}
        owner="You"
        onPicked={onPicked}
      />
    )
    const box = screen.getByPlaceholderText('Search by name or username')
    fireEvent.change(box, { target: { value: 'bren' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(screen.getByText('Username check failed.')).toBeTruthy()
    fireEvent.click(screen.getByText('brenda-q'))
    expect(screen.getByText('1 selected')).toBeTruthy()

    const searching = vi.fn()
    const observer = new MutationObserver(() => {
      if (screen.queryByText('Searching…')) {
        searching()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    observer.disconnect()
    // The lookup ran again once, found its match, and nothing else changed meanwhile.
    expect(users).toHaveBeenCalledTimes(2)
    expect(screen.getByText('bren')).toBeTruthy()
    expect(screen.getByText('brennanb2025')).toBeTruthy()
    expect(box).toHaveProperty('value', 'bren')
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(searching).not.toHaveBeenCalled()
    expect(screen.queryByText('Username check failed.')).toBeNull()
  })
})
