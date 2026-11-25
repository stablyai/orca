// @vitest-environment happy-dom
// Who can ask › Add on GitHub, mounted as the bot page draws it (production service, real list and
// grant path): who a pick is through the saved grant, recovery, and refreshes. Synthetic people only.
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deferred,
  gitHubView,
  groupTexts,
  mountWhoCanAsk,
  optionTexts,
  rosterOf,
  searchBox,
  settle,
  typeQuery,
  watchSearching,
  type People,
  type Users
} from './github-who-can-ask-mount'
import { ROSTER_WAIT_MS } from './github-who-can-ask-session'
import { setRendererPluginLanguagePacks, setRendererUiLanguage } from '@/i18n/i18n'
import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId
} from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'

const host = vi.hoisted(() => {
  let view: unknown = null
  const listeners = new Set<() => void>()
  return {
    calls: {
      people: vi.fn<(args: unknown) => Promise<unknown>>(),
      users: vi.fn<(args: { query: string }) => Promise<unknown>>()
    },
    confirm: vi.fn<(grant: { people: { id: string; name: string }[] }) => Promise<boolean>>(),
    update:
      vi.fn<
        (
          bot: unknown,
          updates: { addMembers?: { id: string; name: string }[] }
        ) => Promise<undefined>
      >(),
    read: () => view,
    publish: (next: unknown) => {
      view = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})

vi.mock('@/lib/bot-github-state', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react')
  return {
    ...(await importOriginal<object>()),
    useBotGitHubRead: () => useSyncExternalStore(host.subscribe, host.read)
  }
})
vi.mock('@/lib/bot-connector-host-calls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  botGitHubCalls: () => host.calls
}))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateBot: host.update,
  useHostBots: () => []
}))
vi.mock('../bot-access-confirm', () => ({ useConfirmBotAccess: () => host.confirm }))
vi.mock('@/lib/bot-host-orca-account', () => ({ useBotHostOnOwnAccount: () => true }))
vi.mock('../orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => 'This Mac' }))

const users = (members: { id: string; name: string }[]): Users => ({
  ok: true,
  value: { members, complete: true }
})
const read = (roster: ReturnType<typeof rosterOf>): Promise<People> =>
  Promise.resolve({ ok: true, value: roster })

/** What the confirmation was asked to show, and what the grant saved. */
function granted(): { confirmed: unknown; saved: unknown } {
  const confirmed = host.confirm.mock.calls.at(-1)?.[0].people
  const updates = host.update.mock.calls.at(-1)?.[1]
  return {
    confirmed,
    saved: updates?.addMembers?.map((member) => ({ id: member.id, name: member.name }))
  }
}

async function add(label: RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: label }))
    await vi.advanceTimersByTimeAsync(0)
  })
}

const pick = (text: string): void => {
  const row = screen.getAllByRole('option').find((option) => option.textContent === text)
  if (!row) {
    throw new Error(`no row ${text} in ${optionTexts().join(' | ')}`)
  }
  fireEvent.click(row)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  host.publish(gitHubView())
  // A list request that never answers and an empty username check, unless a test says otherwise.
  host.calls.people.mockReturnValue(new Promise(() => {}))
  host.calls.users.mockResolvedValue(users([]))
  host.confirm.mockResolvedValue(true)
  host.update.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('GPS-C1-01: who a pick is, through confirmation', () => {
  it('drops a cached row the live lookup shows belongs to another account, picked first', async () => {
    const exact = deferred<Users>()
    host.calls.people.mockReturnValue(read(rosterOf([{ id: '21', login: 'sam', name: 'Sam Ito' }])))
    host.calls.users.mockReturnValue(exact.promise)
    mountWhoCanAsk()
    await typeQuery('sam')
    // The list's row shows while the username check is on its way; the owner ticks it.
    pick('samSam Ito')
    expect(screen.getByText('1 selected')).toBeTruthy()
    await act(async () => {
      exact.resolve(users([{ id: '77', name: 'sam' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    // The live account holds that login now: only it is offered, and the stale pick is dropped.
    expect(optionTexts().filter((text) => text.startsWith('sam'))).toEqual([
      'samNot in your repo list'
    ])
    expect(screen.queryByText('Sam Ito')).toBeNull()
    expect(screen.queryByText('1 selected')).toBeNull()
    pick('samNot in your repo list')
    await add(/Add 1 person/)
    expect(granted()).toEqual({
      confirmed: [{ id: '77', name: 'sam' }],
      saved: [{ id: '77', name: 'sam' }]
    })
    expect(host.calls.users).toHaveBeenCalledOnce()
  })

  it('drops an already-selected cached pick once a query edit shows its login is someone else', async () => {
    host.calls.people.mockReturnValue(read(rosterOf([{ id: '21', login: 'sam', name: 'Sam Ito' }])))
    host.calls.users.mockImplementation(async ({ query }) =>
      users(query === 'sam' ? [{ id: '77', name: 'sam' }] : [])
    )
    mountWhoCanAsk()
    await typeQuery('sa')
    pick('samSam Ito')
    await typeQuery('sam')
    await settle()
    expect(screen.queryByText('Sam Ito')).toBeNull()
    expect(groupTexts('Selected')).toEqual([])
    expect(screen.queryByText('1 selected')).toBeNull()
    pick('samNot in your repo list')
    await add(/Add 1 person/)
    expect(granted()).toEqual({
      confirmed: [{ id: '77', name: 'sam' }],
      saved: [{ id: '77', name: 'sam' }]
    })
  })

  it('confirms and saves a renamed pick by its live login', async () => {
    const exact = deferred<Users>()
    host.calls.people.mockReturnValue(
      read(rosterOf([{ id: '31', login: 'samr', name: 'Samuel Reyes' }]))
    )
    host.calls.users.mockReturnValue(exact.promise)
    mountWhoCanAsk()
    await typeQuery('samuel')
    pick('samrSamuel Reyes')
    await act(async () => {
      exact.resolve(users([{ id: '31', name: 'samuel' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(optionTexts()).toContain('samuelSamuel Reyes')
    // Found again by real name, the list's row shows the live login, not the old one.
    await typeQuery('reyes')
    expect(optionTexts()).toContain('samuelSamuel Reyes')
    expect(optionTexts()).not.toContain('samrSamuel Reyes')
    await add(/Add 1 person/)
    expect(granted()).toEqual({
      confirmed: [{ id: '31', name: 'samuel' }],
      saved: [{ id: '31', name: 'samuel' }]
    })
  })
})

it('GPS-C1-01: refreshes a pick renamed since the list, learned after a query edit', async () => {
  host.calls.people.mockReturnValue(
    read(rosterOf([{ id: '31', login: 'samr', name: 'Samuel Reyes' }]))
  )
  host.calls.users.mockImplementation(async ({ query }) =>
    users(query === 'samuel' ? [{ id: '31', name: 'samuel' }] : [])
  )
  mountWhoCanAsk()
  await typeQuery('samr')
  pick('samrSamuel Reyes')
  await typeQuery('samuel')
  await settle()
  expect(optionTexts()).toContain('samuelSamuel Reyes')
  await add(/Add 1 person/)
  expect(granted()).toEqual({
    confirmed: [{ id: '31', name: 'samuel' }],
    saved: [{ id: '31', name: 'samuel' }]
  })
})

describe('GPS-D9-06: a pick that becomes a linked owner', () => {
  it('is left out of the count and the grant, while the other pick stays', async () => {
    host.calls.people.mockReturnValue(
      read(
        rosterOf([
          { id: '41', login: 'maya-c', name: 'Maya Chen' },
          { id: '42', login: 'lee-k', name: 'Lee Kim' }
        ])
      )
    )
    host.calls.users.mockResolvedValue(users([]))
    mountWhoCanAsk()
    await settle(300)
    pick('maya-cMaya Chen')
    pick('lee-kLee Kim')
    expect(screen.getByText('2 selected')).toBeTruthy()
    // The owner links Lee's GitHub account while the picker is open.
    await act(async () => {
      host.publish(
        gitHubView([
          { userId: '1', login: 'owner-one' },
          { userId: '42', login: 'lee-k' }
        ])
      )
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.getByText('1 selected')).toBeTruthy()
    await add(/Add 1 person/)
    expect(granted()).toEqual({
      confirmed: [{ id: '41', name: 'maya-c' }],
      saved: [{ id: '41', name: 'maya-c' }]
    })
  })
})

describe('GPS-D9-01, GPS-C1-06, GPS-D9-07: a remembered pick in Selected', () => {
  it('keeps the login and real name, never a retired source tag, and matches like the search', async () => {
    host.calls.people.mockReturnValue(
      read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya Chen' }]))
    )
    const failing = deferred<Users>()
    host.calls.users.mockImplementation(async ({ query }) =>
      query === 'jordan'
        ? users([{ id: '50', name: 'jordan' }])
        : query === 'jord'
          ? failing.promise
          : users([])
    )
    mountWhoCanAsk()
    await typeQuery('jordan')
    pick('jordanNot in your repo list')
    // An @prefix matches the pick as GitHub search matches it; the outsider tag retired with its answer.
    await typeQuery('@jor')
    expect(groupTexts('Selected')).toEqual(['jordan'])
    // Loading (debounce), then held (username check still out), then failed.
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'jord' }
    })
    expect(groupTexts('Selected')).toEqual(['jordan'])
    await settle(300)
    expect(groupTexts('Selected')).toEqual(['jordan'])
    await act(async () => {
      failing.resolve({ ok: false, error: 'network' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    expect(groupTexts('Selected')).toEqual(['jordan'])
    // A word of the old tag is not who they are.
    await typeQuery('repo')
    expect(groupTexts('Selected')).toEqual([])
    expect(screen.getByText('1 selected')).toBeTruthy()
    // A bare and a prefixed login find the same person.
    await typeQuery('maya-c')
    pick('maya-cMaya Chen')
    await typeQuery('@maya-c')
    expect(optionTexts()).toContain('maya-cMaya Chen')
    expect(screen.getByText('2 selected')).toBeTruthy()
  })
})

const failedRead = (): Promise<People> => Promise.resolve({ ok: false, error: 'network' })
const team = rosterOf([
  { id: '41', login: 'maya-c', name: 'Maya Chen' },
  { id: '42', login: 'lee-k', name: 'Lee Kim' }
])

describe('GPS-D9-03, GPS-C1-05: Try again with an empty search', () => {
  it('offers Try again in the empty-search hint; Enter or a click asks the host once', async () => {
    const second = deferred<People>()
    host.calls.people.mockReturnValueOnce(failedRead()).mockReturnValueOnce(second.promise)
    host.calls.users.mockResolvedValue(users([]))
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    mountWhoCanAsk()
    await settle(300)
    expect(screen.getByText('Find people')).toBeTruthy()
    expect(screen.getByText(/Couldn’t get the repo list\./)).toBeTruthy()
    const searching = watchSearching()
    screen.getByRole('button', { name: 'Try again' }).focus()
    await user.keyboard('{Enter}')
    await settle(ROSTER_WAIT_MS * 2)
    // Asked again: a repeated activation shares the request still on its way.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(ROSTER_WAIT_MS * 2)
    expect(host.calls.people).toHaveBeenCalledTimes(2)
    await act(async () => {
      second.resolve({ ok: true, value: team })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(optionTexts()).toEqual(['lee-kLee Kim', 'maya-cMaya Chen', 'YouOwnerCan ask'])
    expect(searching.stop()).toBe(0)
    expect(host.calls.users).not.toHaveBeenCalled()
  })

  it('offers Try again after a pick is made and the search cleared, keeping the pick', async () => {
    const second = deferred<People>()
    host.calls.people.mockReturnValueOnce(failedRead()).mockReturnValueOnce(second.promise)
    host.calls.users.mockResolvedValue(users([{ id: '9', name: 'brennan' }]))
    mountWhoCanAsk()
    await typeQuery('brennan')
    pick('brennanRepos not checked')
    await typeQuery('')
    expect(screen.getByText('Find people')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(ROSTER_WAIT_MS * 2)
    expect(host.calls.people).toHaveBeenCalledTimes(2)
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(groupTexts('Selected')).toEqual(['brennan'])
    await act(async () => {
      second.resolve({ ok: true, value: team })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(optionTexts()).toContain('maya-cMaya Chen')
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('offers no Try again for a list the host already spent', async () => {
    host.calls.people.mockResolvedValue({ ok: true, value: { status: 'unavailable', spent: true } })
    mountWhoCanAsk()
    await settle(300)
    expect(screen.getByText(/Couldn’t read repos\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('GPS-D9-04: one Try again at a time, until its whole answer', () => {
  async function failedHalf(): Promise<{
    roster: ReturnType<typeof deferred<People>>
    retried: ReturnType<typeof deferred<Users>>
  }> {
    const roster = deferred<People>()
    const retried = deferred<Users>()
    host.calls.people.mockReturnValueOnce(roster.promise)
    host.calls.users
      .mockResolvedValueOnce(users([{ id: '9', name: 'brennan' }]))
      .mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockReturnValueOnce(retried.promise)
    mountWhoCanAsk()
    await typeQuery('brennan', 300 + ROSTER_WAIT_MS)
    pick('brennanRepos still loading')
    await typeQuery('bren', 300 + ROSTER_WAIT_MS)
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    return { roster, retried }
  }

  const asked = () => ({
    people: host.calls.people.mock.calls.length,
    users: host.calls.users.mock.calls.map(([args]) => args.query)
  })

  it('list settles first: another activation starts nothing, and the answer lands whole', async () => {
    const { roster, retried } = await failedHalf()
    const searching = watchSearching()
    await act(async () => {
      roster.resolve({ ok: false, error: 'network' })
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(ROSTER_WAIT_MS * 2)
    expect(asked()).toEqual({ people: 1, users: ['brennan', 'bren', 'bren'] })
    // Held: the earlier answer stays, the pick and query too.
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    expect(groupTexts('Selected')[0]).toMatch(/^brennan/)
    await act(async () => {
      retried.resolve(users([{ id: '12', name: 'bren' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked()).toEqual({ people: 1, users: ['brennan', 'bren', 'bren'] })
    expect(optionTexts()).toContain('brenRepos not checked')
    expect(screen.queryByText(/Username check failed\./)).toBeNull()
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(searchBox()).toHaveProperty('value', 'bren')
    expect(searching.stop()).toBe(0)
  })

  it('username settles first: nothing paints until the list answers too', async () => {
    const { roster, retried } = await failedHalf()
    const searching = watchSearching()
    await act(async () => {
      retried.resolve(users([{ id: '12', name: 'bren' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(ROSTER_WAIT_MS * 2)
    expect(asked()).toEqual({ people: 1, users: ['brennan', 'bren', 'bren'] })
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    expect(groupTexts('Selected')[0]).toMatch(/^brennan/)
    await act(async () => {
      roster.resolve({ ok: true, value: team })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked()).toEqual({ people: 1, users: ['brennan', 'bren', 'bren'] })
    expect(optionTexts()).toContain('brenNot in your repo list')
    expect(screen.queryByText(/Username check failed\./)).toBeNull()
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(searching.stop()).toBe(0)
  })

  it('a list landing during the next query’s debounce waits for that debounce', async () => {
    const roster = deferred<People>()
    host.calls.people.mockReturnValueOnce(roster.promise)
    host.calls.users.mockResolvedValue(users([]))
    mountWhoCanAsk()
    await typeQuery('maya')
    fireEvent.change(searchBox(), { target: { value: 'lee' } })
    await settle(100)
    await act(async () => {
      roster.resolve({ ok: true, value: team })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked().users).toEqual(['maya'])
    fireEvent.change(searchBox(), { target: { value: 'leo' } })
    await settle(300)
    expect(asked()).toEqual({ people: 1, users: ['maya', 'leo'] })
  })
})

describe('GPS-C1-03: list rows while the username check is out', () => {
  it('shows matching list rows at once, then adds the exact answer to the same query', async () => {
    const maya = deferred<Users>()
    const zed = deferred<Users>()
    const kai = deferred<Users>()
    host.calls.people.mockReturnValue(read(team))
    host.calls.users.mockImplementation(({ query }) =>
      query === 'maya'
        ? maya.promise
        : query === 'zed'
          ? zed.promise
          : query === 'kai'
            ? kai.promise
            : Promise.resolve(users([]))
    )
    mountWhoCanAsk()
    await typeQuery('maya')
    expect(optionTexts()).toContain('maya-cMaya Chen')
    expect(screen.queryByText(/No one found/)).toBeNull()
    await act(async () => {
      maya.resolve(users([{ id: '60', name: 'maya' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(optionTexts()).toEqual(
      expect.arrayContaining(['maya-cMaya Chen', 'mayaNot in your repo list'])
    )
    // Nothing local and the check still out: still searching, never "no one".
    await typeQuery('zed')
    expect(screen.getByText('Searching…')).toBeTruthy()
    expect(screen.queryByText(/No one found/)).toBeNull()
    await act(async () => {
      zed.resolve({ ok: false, error: 'network' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    // An answer for a query the owner left never paints.
    await typeQuery('kai')
    await typeQuery('kim')
    await act(async () => {
      kai.resolve(users([{ id: '70', name: 'kai' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.queryByText('kai')).toBeNull()
    expect(host.calls.users.mock.calls.map(([args]) => args.query)).toEqual([
      'maya',
      'zed',
      'kai',
      'kim'
    ])
    expect(host.calls.people).toHaveBeenCalledOnce()
  })
})

describe('GPS-D9-05, GPS-C1-04: an equal GitHub state refresh', () => {
  it('keeps the session while the check is out, after it lands, and while failed', async () => {
    const exact = deferred<Users>()
    host.calls.people.mockReturnValue(read(team))
    host.calls.users.mockReturnValue(exact.promise)
    mountWhoCanAsk()
    await typeQuery('maya')
    const searching = watchSearching()
    const refresh = async (): Promise<void> => {
      await act(async () => {
        host.publish(gitHubView())
        await vi.advanceTimersByTimeAsync(300)
      })
    }
    await refresh()
    expect(host.calls.people).toHaveBeenCalledOnce()
    expect(optionTexts()).toContain('maya-cMaya Chen')
    await act(async () => {
      exact.resolve(users([{ id: '60', name: 'maya' }]))
      await vi.advanceTimersByTimeAsync(0)
    })
    await refresh()
    expect(optionTexts()).toContain('mayaNot in your repo list')
    expect(searching.stop()).toBe(0)
    expect(host.calls.people).toHaveBeenCalledOnce()
    expect(host.calls.users).toHaveBeenCalledOnce()
  })

  it('keeps a failed list’s Try again, and its retry, across a refresh', async () => {
    const second = deferred<People>()
    host.calls.people.mockReturnValueOnce(failedRead()).mockReturnValueOnce(second.promise)
    mountWhoCanAsk()
    await settle(300)
    await act(async () => {
      host.publish(gitHubView())
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(host.calls.people).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    await act(async () => {
      host.publish(gitHubView())
      await vi.advanceTimersByTimeAsync(300)
    })
    await act(async () => {
      second.resolve({ ok: true, value: team })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(host.calls.people).toHaveBeenCalledTimes(2)
    expect(optionTexts()).toContain('maya-cMaya Chen')
  })

  it('a real scope change reads for the new scope and never paints the old answer', async () => {
    const before = deferred<People>()
    const after = deferred<People>()
    host.calls.people.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    mountWhoCanAsk()
    await settle(300)
    await act(async () => {
      host.publish(
        gitHubView(undefined, [{ installationId: '12', accountLogin: 'acme', repos: ['acme/api'] }])
      )
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(host.calls.people).toHaveBeenCalledTimes(2)
    expect(host.calls.people.mock.calls[1]?.[0]).toMatchObject({
      scope: { repositories: ['acme/api'] }
    })
    await act(async () => {
      before.resolve({
        ok: true,
        value: rosterOf([{ id: '80', login: 'old-scope', name: 'Old Scope' }])
      })
      after.resolve({ ok: true, value: team })
      await vi.advanceTimersByTimeAsync(ROSTER_WAIT_MS)
    })
    expect(optionTexts()).toContain('maya-cMaya Chen')
    expect(screen.queryByText('old-scope')).toBeNull()
  })
})

describe('GPS-D9-02: a list read only from organizations', () => {
  const orgsOnly = (): void => {
    host.publish(
      gitHubView(undefined, [{ installationId: '11', accountLogin: 'acme', repos: null }])
    )
    host.calls.people.mockReturnValue(
      read({
        ...rosterOf([{ id: '41', login: 'maya-c', name: 'Maya Chen' }], {
          repositories: false,
          organizations: true
        }),
        readFor: { scope: { repositories: [], owners: ['acme'], more: false }, owner: 'owner-one' }
      })
    )
    host.calls.users.mockImplementation(async ({ query }) =>
      users(query === 'jordan' ? [{ id: '50', name: 'jordan' }] : [])
    )
  }

  it('calls a stranger and the list’s date by the org list it is', async () => {
    orgsOnly()
    mountWhoCanAsk()
    await typeQuery('jordan')
    expect(optionTexts()).toContain('jordanNot in your org list')
    expect(screen.getByText(/Org list from /)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/repo list/i)
  })

  it('says the org list was searched when no one matches', async () => {
    orgsOnly()
    mountWhoCanAsk()
    await typeQuery('zzqx')
    expect(screen.getByText('No one found for “zzqx”')).toBeTruthy()
    expect(screen.getByText(/Searched your org list and exact usernames\./)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/repo list/i)
  })
})

describe('GPS-C1-07: the setup picker’s list qualifiers under a language pack', () => {
  const packId = 'plugin:synthetic.pack/en' as const
  beforeEach(async () => {
    const pack = parsePluginLanguagePackArtifact(
      JSON.stringify({
        bots: {
          whoCanAsk: { addedCount: 'Synthetic {{count}}/{{max}}' },
          github: {
            whoCanAsk: {
              listFrom: 'Synthetic list {{time}}.',
              notInList: 'Synthetic absence',
              searchedListExact: 'Synthetic searched.',
              exactOnly: 'Synthetic exact only.',
              localNone: 'Synthetic none.'
            }
          }
        }
      }),
      'tolerant'
    )
    if (!pack.ok) {
      throw new Error(pack.error)
    }
    setRendererPluginLanguagePacks([
      {
        id: packId,
        resourceLanguage: pluginLanguageResourceId(packId),
        pluginKey: 'synthetic',
        locale: 'en-US',
        coverage: 1,
        catalog: pack.catalog
      }
    ])
    await setRendererUiLanguage(packId)
  })
  afterEach(async () => {
    await setRendererUiLanguage('en')
    setRendererPluginLanguagePacks([])
  })

  it('keeps the dated list and absence wording in English', async () => {
    host.calls.people.mockReturnValue(read(team))
    host.calls.users.mockImplementation(async ({ query }) =>
      users(query === 'jordan' ? [{ id: '50', name: 'jordan' }] : [])
    )
    mountWhoCanAsk()
    // The pack is live: its unprotected count line shows.
    expect(screen.getByText('Synthetic 0/50')).toBeTruthy()
    await typeQuery('jordan')
    expect(optionTexts()).toContain('jordanNot in your repo list')
    expect(screen.getByText(/Repo list from /)).toBeTruthy()
    await typeQuery('zzqx')
    expect(screen.getByText(/Searched your repo list and exact usernames\./)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Synthetic (list|absence|searched)/)
  })

  it('keeps the exact-only guard in English on an empty readable scope', async () => {
    host.publish(gitHubView(undefined, []))
    host.calls.users.mockResolvedValue(users([{ id: '50', name: 'jordan' }]))
    mountWhoCanAsk()
    await typeQuery('jordan')
    // Nothing is connected, so nothing names repos.
    expect(optionTexts()).toContain('jordanList not checked')
    // The pack is live (its unprotected count line shows); the guard stays English.
    expect(screen.getByText('Synthetic 0/50')).toBeTruthy()
    expect(screen.getByText(/No repos or orgs connected\.\s+Exact usernames only\./)).toBeTruthy()
    expect(host.calls.people).not.toHaveBeenCalled()
  })
})
