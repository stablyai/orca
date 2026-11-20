import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BotGitHubRoster,
  ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { ROSTER_WAIT_MS, gitHubWhoCanAskSession } from './github-who-can-ask-session'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: echoes the English default like i18next does with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))) as never

const scope = { repositories: ['stablyai/orca'], owners: [], more: false }
const roster: BotGitHubRoster = {
  status: 'read',
  people: [
    { id: '2', login: 'brennanb2025', name: 'Brennan Benson' },
    { id: '5', login: 'jinwoo-h', name: 'Jinwoo Hong' }
  ],
  from: { repositories: true, organizations: false },
  complete: true,
  omitted: false,
  cut: { people: false, members: false, repositories: false },
  readAt: 0,
  reused: false,
  readFor: { scope: { repositories: ['stablyai/orca'], owners: [], more: false }, owner: 'owner' }
}
const deferred = <T>() => {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Users = BotSlackResult<ConnectorGitHubUsersResponse>
const noOne: Users = { ok: true, value: { members: [], complete: true } }
const stranger: Users = {
  ok: true,
  value: { members: [{ id: '9', name: 'brennan' }], complete: true }
}
const names = (result: BotSlackResult<{ members: { name: string }[] }>) =>
  result.ok ? result.value.members.map((member) => member.name) : result.error

describe('one Add picker open on GitHub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks for the roster once and filters it as the owner types', async () => {
    const people = vi.fn(async () => ({ ok: true as const, value: roster }))
    const users = vi.fn(async (_args: { query: string }): Promise<Users> => noOne)
    const session = gitHubWhoCanAskSession(
      { people, users },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    expect(names(await session.search(''))).toEqual(['brennanb2025', 'jinwoo-h'])
    expect(names(await session.search('bren'))).toEqual(['brennanb2025'])
    expect(names(await session.search('hong'))).toEqual(['jinwoo-h'])
    expect(people).toHaveBeenCalledOnce()
    // The exact lookup runs only for a query that can be a username, never for an empty box.
    expect(users.mock.calls.map(([args]) => args.query)).toEqual(['bren', 'hong'])
  })

  it('answers while the roster is slow, tells its one listener once, and never repeats the exact lookup', async () => {
    const slow = deferred<BotSlackResult<BotGitHubRoster>>()
    const users = vi.fn(async (_args: { query: string }): Promise<Users> => stranger)
    const session = gitHubWhoCanAskSession(
      { people: () => slow.promise, users },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    const replaced = vi.fn()
    const told = vi.fn()
    session.onUpdate?.(replaced)
    session.onUpdate?.(told)
    const first = session.search('brennan')
    await vi.advanceTimersByTimeAsync(ROSTER_WAIT_MS)
    expect(names(await first)).toEqual(['brennan'])
    slow.resolve({ ok: true, value: roster })
    await vi.advanceTimersByTimeAsync(0)
    // Only the latest listener is told, and only once.
    expect(replaced).not.toHaveBeenCalled()
    expect(told).toHaveBeenCalledOnce()
    expect(names(await session.search('brennan'))).toEqual(['brennanb2025', 'brennan'])
    expect(users).toHaveBeenCalledOnce()
    // A changed query still gets its own exact answer.
    await session.search('jinwoo')
    expect(users.mock.calls.map(([args]) => args.query)).toEqual(['brennan', 'jinwoo'])
    // Once the roster is in, a listener has nothing to wait for.
    const late = vi.fn()
    session.onUpdate?.(late)()
    expect(late).not.toHaveBeenCalled()
  })

  it('keeps no search waiting on the roster past its deadline, however many queries are typed', async () => {
    const never = deferred<BotSlackResult<BotGitHubRoster>>()
    const session = gitHubWhoCanAskSession(
      { people: () => never.promise, users: async () => noOne },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    const answers = ['b', 'br', 'bre', 'bren'].map((query) => session.search(query))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.waiters).toBe(4)
    await vi.advanceTimersByTimeAsync(ROSTER_WAIT_MS)
    // Every search answered and let go of the roster, which is still on its way.
    expect(session.waiters).toBe(0)
    for (const answer of await Promise.all(answers)) {
      expect(answer.ok && answer.value.empty?.title).toBe('Still loading your repos')
    }
  })

  it('uses a roster that lands while the exact lookup is still on its way', async () => {
    const slowRoster = deferred<BotSlackResult<BotGitHubRoster>>()
    const slowExact = deferred<Users>()
    const session = gitHubWhoCanAskSession(
      { people: () => slowRoster.promise, users: () => slowExact.promise },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    const answer = session.search('brennan')
    await vi.advanceTimersByTimeAsync(ROSTER_WAIT_MS)
    slowRoster.resolve({ ok: true, value: roster })
    await vi.advanceTimersByTimeAsync(0)
    slowExact.resolve(noOne)
    expect(names(await answer)).toEqual(['brennanb2025'])
  })

  it('keeps a failed exact lookup open for a roster still loading, then fails only if both did', async () => {
    const failed: Users = { ok: false, error: 'network' }
    const late = deferred<BotSlackResult<BotGitHubRoster>>()
    const session = gitHubWhoCanAskSession(
      { people: () => late.promise, users: async () => failed },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    const first = session.search('brennan')
    await vi.advanceTimersByTimeAsync(ROSTER_WAIT_MS)
    expect((await first).ok).toBe(true)
    late.resolve({ ok: true, value: roster })
    await vi.advanceTimersByTimeAsync(0)
    const second = await session.search('brennan')
    expect(names(second)).toEqual(['brennanb2025'])
    expect(second.ok && second.value.note).toBe('Username check failed.')

    const unreadable = gitHubWhoCanAskSession(
      {
        people: async () => ({ ok: true, value: { status: 'unavailable' } }),
        users: async () => failed
      },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    expect(await unreadable.search('brennan')).toEqual(failed)
  })

  it('asks a failed exact lookup again only when told to retry', async () => {
    const users = vi
      .fn<(args: { query: string }) => Promise<Users>>()
      .mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockResolvedValue(stranger)
    const session = gitHubWhoCanAskSession(
      { people: async () => ({ ok: true, value: roster }), users },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
    expect((await session.search('brennan')).ok && (await session.search('brennan'))).toMatchObject(
      {
        value: { retryable: true }
      }
    )
    // Asking again for the same query reuses the failure; only retry() forgets it.
    expect(users).toHaveBeenCalledOnce()
    session.retry?.()
    expect(names(await session.search('brennan'))).toEqual(['brennanb2025', 'brennan'])
    expect(users).toHaveBeenCalledTimes(2)
  })

  it('sends no roster request until the GitHub state is known, or when nothing is connected', async () => {
    const people = vi.fn()
    const users = vi.fn(async (): Promise<Users> => noOne)
    for (const unknown of [undefined, { repositories: [], owners: [], more: false }]) {
      const session = gitHubWhoCanAskSession(
        { people, users },
        { scope: unknown, ownerLogin: null, producer: 'local', t }
      )
      expect((await session.search('octocat')).ok).toBe(true)
    }
    expect(people).not.toHaveBeenCalled()
  })
})
