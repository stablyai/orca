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
  cut: false
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

describe('one Add picker open on GitHub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks for the roster once and filters it as the owner types', async () => {
    const people = vi.fn(async () => ({ ok: true as const, value: roster }))
    const users = vi.fn(async (_args: { query: string }): Promise<Users> => noOne)
    const search = gitHubWhoCanAskSession(
      { people, users },
      { scope, ownerLogin: 'owner', hostName: null, t }
    )
    const names = async (query: string) => {
      const result = await search(query)
      return result.ok ? result.value.members.map((member) => member.name) : result.error
    }
    expect(await names('')).toEqual(['brennanb2025', 'jinwoo-h'])
    expect(await names('bren')).toEqual(['brennanb2025'])
    expect(await names('hong')).toEqual(['jinwoo-h'])
    expect(people).toHaveBeenCalledOnce()
    // The exact lookup runs only for a query that can be a username, never for an empty box.
    expect(users.mock.calls.map(([args]) => args.query)).toEqual(['bren', 'hong'])
  })

  it('answers with the exact match while the roster is slow, then asks again when it lands', async () => {
    const slow = deferred<BotSlackResult<BotGitHubRoster>>()
    const users = vi.fn(async (): Promise<Users> => ({
      ok: true,
      value: { members: [{ id: '9', name: 'brennan' }], complete: true }
    }))
    const search = gitHubWhoCanAskSession(
      { people: () => slow.promise, users },
      { scope, ownerLogin: 'owner', hostName: null, t }
    )
    const answer = search('brennan')
    await vi.advanceTimersByTimeAsync(ROSTER_WAIT_MS)
    const first = await answer
    expect(first.ok && first.value.members).toEqual([
      { id: '9', name: 'brennan', tag: 'Repos still loading' }
    ])
    expect(first.ok && first.value.note).toBe('Still loading your repos.')
    let refreshed = false
    void (first.ok ? first.value.pending : undefined)?.then(() => {
      refreshed = true
    })
    slow.resolve({ ok: true, value: roster })
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshed).toBe(true)
    const second = await search('brennan')
    expect(second.ok && second.value.members.map((member) => member.name)).toEqual([
      'brennanb2025',
      'brennan'
    ])
  })

  it('sends no roster request until the GitHub state is known, or when nothing is connected', async () => {
    const people = vi.fn()
    const users = vi.fn(async (): Promise<Users> => noOne)
    for (const unknown of [undefined, { repositories: [], owners: [], more: false }]) {
      const search = gitHubWhoCanAskSession(
        { people, users },
        { scope: unknown, ownerLogin: null, hostName: null, t }
      )
      expect((await search('octocat')).ok).toBe(true)
    }
    expect(people).not.toHaveBeenCalled()
  })
})
