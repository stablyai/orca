// @vitest-environment happy-dom
// Who can ask › Add on GitHub, mounted as setup's turn-on step (production service, real list and
// grant path): who a pick is when a username check is still out or settled elsewhere, across
// queries, lists and contexts, through the confirmation and the saved grant. Synthetic data only.
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import {
  addButton,
  bot,
  deferred,
  gitHubView,
  mountWhoCanAsk,
  optionTexts,
  pickRow,
  rosterOf,
  settle,
  typeQuery,
  usersOf,
  watchSearching,
  type People,
  type Users
} from './github-who-can-ask-mount'
import { ROSTER_WAIT_MS } from './github-who-can-ask-session'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage } from '@/i18n/i18n'
import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId
} from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'

const host = vi.hoisted(() => {
  let view: unknown = null
  let label = 'This Mac'
  const listeners = new Set<() => void>()
  const tell = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const callsOf = () => ({
    people: vi.fn<(args: unknown) => Promise<unknown>>(),
    users: vi.fn<(args: { query: string }) => Promise<unknown>>()
  })
  const byHost = new Map<string, ReturnType<typeof callsOf>>()
  return {
    calls: (hostId = 'local') => {
      if (!byHost.has(hostId)) {
        byHost.set(hostId, callsOf())
      }
      return byHost.get(hostId)!
    },
    reset: () => byHost.clear(),
    confirm: vi.fn<(grant: { people: { id: string; name: string }[] }) => Promise<boolean>>(),
    update:
      vi.fn<
        (
          bot: unknown,
          updates: { addMembers?: { id: string; name: string }[] }
        ) => Promise<undefined>
      >(),
    read: () => view,
    label: () => label,
    publish: (next: unknown) => {
      view = next
      tell()
    },
    relabel: (next: string) => {
      label = next
      tell()
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
  botGitHubCalls: (hostId: string) => host.calls(hostId)
}))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateBot: host.update,
  useHostBots: () => []
}))
vi.mock('../bot-access-confirm', () => ({ useConfirmBotAccess: () => host.confirm }))
vi.mock('@/lib/bot-host-orca-account', () => ({ useBotHostOnOwnAccount: () => true }))
vi.mock('../orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('../use-bot-host-label', async () => {
  const { useSyncExternalStore } = await import('react')
  return { useBotHostLabel: () => useSyncExternalStore(host.subscribe, host.label) }
})

const calls = host.calls
const read = (roster: ReturnType<typeof rosterOf>): Promise<People> =>
  Promise.resolve({ ok: true, value: roster })
const failed = (): Promise<People> => Promise.resolve({ ok: false, error: 'network' })
const lookups = (hostId = 'local') => calls(hostId).users.mock.calls.map(([args]) => args.query)

/** What each confirmation was asked about, and what the grant saved. */
function granted(): { confirmed: unknown[]; saved: unknown } {
  const updates = host.update.mock.calls.at(-1)?.[1]
  return {
    confirmed: host.confirm.mock.calls.map(([grant]) => grant.people),
    saved: updates?.addMembers?.map((member) => ({ id: member.id, name: member.name }))
  }
}

async function clickAdd(): Promise<void> {
  await act(async () => {
    fireEvent.click(addButton())
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function land<T>(gate: { resolve: (value: T) => void }, value: T): Promise<void> {
  await act(async () => {
    gate.resolve(value)
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** The held Add: disabled, its visible name kept, described by the checking status. */
function expectHeld(): void {
  const button = addButton()
  expect(button).toHaveProperty('disabled', true)
  const describedBy = button.getAttribute('aria-describedby')
  expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(
    'Checking a username…'
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  host.publish(gitHubView())
  host.relabel('This Mac')
  calls().people.mockReturnValue(new Promise(() => {}))
  calls().users.mockResolvedValue(usersOf([]))
  host.confirm.mockResolvedValue(true)
  host.update.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  host.reset()
})

describe('GPS-C5-01: Add waits for a check that could change who a pick is', () => {
  it('different account, same login: held, then the stale pick is dropped before confirming', async () => {
    const exact = deferred<Users>()
    calls().people.mockReturnValue(read(rosterOf([{ id: '21', login: 'sam', name: 'Sam Ito' }])))
    calls().users.mockReturnValue(exact.promise)
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('samSam Ito')
    expectHeld()
    await clickAdd()
    expect(host.confirm).not.toHaveBeenCalled()
    await land(exact, usersOf([{ id: '77', name: 'sam' }]))
    expect(screen.queryByText('1 selected')).toBeNull()
    pickRow('samNot in your repo list')
    await clickAdd()
    expect(granted()).toEqual({
      confirmed: [[{ id: '77', name: 'sam' }]],
      saved: [{ id: '77', name: 'sam' }]
    })
  })

  it('same account, renamed: held, then confirmed and saved under the live login', async () => {
    const exact = deferred<Users>()
    calls().people.mockReturnValue(
      read(rosterOf([{ id: '31', login: 'samr', name: 'Samuel Reyes' }]))
    )
    calls().users.mockReturnValue(exact.promise)
    mountWhoCanAsk()
    await typeQuery('samuel')
    pickRow('samrSamuel Reyes')
    expectHeld()
    // Released before Add: the check answers, and Add goes ahead with what it said.
    await land(exact, usersOf([{ id: '31', name: 'samuel' }]))
    expect(addButton()).toHaveProperty('disabled', false)
    await clickAdd()
    expect(granted()).toEqual({
      confirmed: [[{ id: '31', name: 'samuel' }]],
      saved: [{ id: '31', name: 'samuel' }]
    })
  })

  it('an exact-only pick rechecked after another lookup: held, and dropped if the login moved', async () => {
    const recheck = deferred<Users>()
    calls().people.mockReturnValue(read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }])))
    calls()
      .users.mockResolvedValueOnce(usersOf([{ id: '50', name: 'jordan' }]))
      .mockResolvedValueOnce(usersOf([]))
      .mockReturnValueOnce(recheck.promise)
    mountWhoCanAsk()
    await typeQuery('jordan')
    pickRow('jordanNot in your repo list')
    await typeQuery('maya')
    await typeQuery('jordan')
    expectHeld()
    await land(recheck, usersOf([{ id: '51', name: 'jordan' }]))
    expect(screen.queryByText('1 selected')).toBeNull()
    expect(lookups()).toEqual(['jordan', 'maya', 'jordan'])
    expect(host.confirm).not.toHaveBeenCalled()
  })

  it('an uncontested exact-only pick, and an unrelated pick while another login is checked, add at once', async () => {
    const other = deferred<Users>()
    calls().people.mockReturnValue(read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }])))
    calls().users.mockImplementation(({ query }) =>
      query === 'jordan'
        ? Promise.resolve(usersOf([{ id: '50', name: 'jordan' }]))
        : query === 'zed'
          ? other.promise
          : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('jordan')
    pickRow('jordanNot in your repo list')
    await typeQuery('maya')
    pickRow('maya-cMaya C')
    await typeQuery('zed')
    expect(addButton()).toHaveProperty('disabled', false)
    await clickAdd()
    expect(granted()).toEqual({
      confirmed: [
        [
          { id: '50', name: 'jordan' },
          { id: '41', name: 'maya-c' }
        ]
      ],
      saved: [
        { id: '50', name: 'jordan' },
        { id: '41', name: 'maya-c' }
      ]
    })
  })
})

describe('GPS-C5-02: every check counts, whatever paints', () => {
  it('a check settled before a late list, under an edited query, hides the listed old holder', async () => {
    const roster = deferred<People>()
    calls().people.mockReturnValue(roster.promise)
    calls().users.mockImplementation(async ({ query }) =>
      usersOf(query === 'sam' ? [{ id: '77', name: 'sam' }] : [])
    )
    mountWhoCanAsk()
    await typeQuery('sam', 300)
    await typeQuery('sa', 300)
    await land(roster, { ok: true, value: rosterOf([{ id: '21', login: 'sam', name: 'Sam Ito' }]) })
    await settle(ROSTER_WAIT_MS)
    expect(screen.queryByText('Sam Ito')).toBeNull()
  })

  it('a check landing after its query was left still drops the pick it contradicts', async () => {
    const exact = deferred<Users>()
    calls().people.mockReturnValue(
      read(
        rosterOf([
          { id: '21', login: 'sam', name: 'Sam Ito' },
          { id: '41', login: 'maya-c', name: 'Maya C' }
        ])
      )
    )
    calls().users.mockImplementation(({ query }) =>
      query === 'sam' ? exact.promise : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('samSam Ito')
    await typeQuery('maya')
    pickRow('maya-cMaya C')
    await land(exact, usersOf([{ id: '77', name: 'sam' }]))
    expect(screen.getByText('1 selected')).toBeTruthy()
    await clickAdd()
    expect(granted()).toEqual({
      confirmed: [[{ id: '41', name: 'maya-c' }]],
      saved: [{ id: '41', name: 'maya-c' }]
    })
  })

  it.each([
    ['a changed scope on the same host', 'local'],
    ['a new executing host', 'remote-1']
  ])('a pick carried into %s is checked against what that context learns', async (_c, next) => {
    const before = read(
      rosterOf([
        { id: '2', login: 'sam', name: 'Sam Ito' },
        { id: '41', login: 'maya-c', name: 'Maya C' }
      ])
    )
    const after = read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }]))
    // The first context's check finds id 2 holding "sam"; the next context's finds id 9.
    const holders = [[{ id: '2', name: 'sam' }], [{ id: '9', name: 'sam' }]]
    const answer = async ({ query }: { query: string }) =>
      usersOf(query === 'sam' ? (holders.shift() ?? []) : [])
    calls().people.mockReturnValueOnce(before).mockReturnValue(after)
    calls().users.mockImplementation(answer)
    const later = calls(next)
    later.people.mockReturnValue(after)
    later.users.mockImplementation(answer)
    const view = mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('samSam Ito')
    await typeQuery('maya')
    pickRow('maya-cMaya C')
    await act(async () => {
      if (next === 'local') {
        host.publish(
          gitHubView(undefined, [
            { installationId: '12', accountLogin: 'acme', repos: ['acme/api'] }
          ])
        )
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same test bot on another host.
        view.rerender({ ...bot, hostId: next } as unknown as Bot)
      }
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.getByText('2 selected')).toBeTruthy()
    await typeQuery('sam')
    expect(screen.getByText('1 selected')).toBeTruthy()
    await clickAdd()
    expect(granted()).toEqual({
      confirmed: [[{ id: '41', name: 'maya-c' }]],
      saved: [{ id: '41', name: 'maya-c' }]
    })
    expect(calls(next).people).toHaveBeenCalledTimes(next === 'local' ? 2 : 1)
  })
})

describe('GPS-C5-03, GPS-C5-09: a renamed account keeps its place; its old login does not', () => {
  const both = () => {
    calls().people.mockReturnValue(read(rosterOf([{ id: '31', login: 'sam', name: 'Sam Ito' }])))
  }

  it.each([
    ['old login first', ['sam', 'samuel']],
    ['new login first', ['samuel', 'sam']]
  ])('%s: the renamed id and the login’s new holder both stay selectable', async (_c, order) => {
    both()
    calls().users.mockImplementation(async ({ query }) =>
      usersOf(
        query === 'sam'
          ? [{ id: '77', name: 'sam' }]
          : query === 'samuel'
            ? [{ id: '31', name: 'samuel' }]
            : []
      )
    )
    mountWhoCanAsk()
    for (const query of order) {
      await typeQuery(query)
    }
    await typeQuery('samuel')
    expect(optionTexts()).toContain('samuelSam Ito')
    await typeQuery('sam')
    expect(optionTexts()).toEqual(expect.arrayContaining(['samuelSam Ito']))
    expect(optionTexts().filter((text) => text.startsWith('samNot'))).toEqual([
      'samNot in your repo list'
    ])
    pickRow('samuelSam Ito')
    await clickAdd()
    expect(granted().saved).toEqual([{ id: '31', name: 'samuel' }])
  })

  it('an older check of the old login landing last changes nothing', async () => {
    both()
    const old = deferred<Users>()
    let first = true
    calls().users.mockImplementation(({ query }) => {
      if (query === 'sam' && first) {
        first = false
        return old.promise
      }
      return Promise.resolve(
        usersOf(
          query === 'sam'
            ? [{ id: '77', name: 'sam' }]
            : query === 'samuel'
              ? [{ id: '31', name: 'samuel' }]
              : []
        )
      )
    })
    mountWhoCanAsk()
    await typeQuery('sam')
    await typeQuery('samuel')
    await typeQuery('sam')
    await land(old, usersOf([{ id: '31', name: 'sam' }]))
    await typeQuery('samuel')
    expect(optionTexts()).toContain('samuelSam Ito')
    await typeQuery('sam')
    expect(optionTexts()).toContain('samNot in your repo list')
  })

  it('matches a renamed person by the confirmed login and real name, not the old alias', async () => {
    calls().people.mockReturnValue(
      read(rosterOf([{ id: '31', login: 'samr', name: 'Samuel Reyes' }]))
    )
    calls().users.mockImplementation(async ({ query }) =>
      usersOf(query === 'samuel' ? [{ id: '31', name: 'samuel' }] : [])
    )
    mountWhoCanAsk()
    await typeQuery('samuel')
    await typeQuery('samr')
    expect(optionTexts().some((text) => text.includes('Samuel Reyes'))).toBe(false)
    await typeQuery('samu')
    expect(optionTexts()).toContain('samuelSamuel Reyes')
    await typeQuery('reyes')
    expect(optionTexts()).toContain('samuelSamuel Reyes')
  })
})

describe('GPS-C5-04: Try again on a hard error asks only what failed, once', () => {
  it('keeps an answered list and asks the failed lookup again in place, by Enter', async () => {
    const again = deferred<Users>()
    calls().people.mockReturnValue(read(rosterOf([])))
    calls()
      .users.mockResolvedValueOnce({ ok: false, error: 'github_off' })
      .mockReturnValueOnce(again.promise)
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    mountWhoCanAsk()
    await typeQuery('jordan')
    const button = screen.getByRole('button', { name: 'Try again' })
    button.focus()
    await user.keyboard('{Enter}')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(ROSTER_WAIT_MS)
    expect(calls().people).toHaveBeenCalledOnce()
    expect(lookups()).toEqual(['jordan', 'jordan'])
    await land(again, usersOf([{ id: '50', name: 'jordan' }]))
    expect(optionTexts()).toContain('jordanNot in your repo list')
  })

  it.each([
    ['list first', 'people'],
    ['lookup first', 'users']
  ])('an unanswered list and a failed lookup, retried together: %s', async (_c, first) => {
    const people = deferred<People>()
    const lookup = deferred<Users>()
    calls().people.mockReturnValueOnce(failed()).mockReturnValueOnce(people.promise)
    calls()
      .users.mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockReturnValueOnce(lookup.promise)
    mountWhoCanAsk()
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    // Both failures stay named.
    expect(screen.getByText(/Couldn’t get the repo list\.\s+Username check failed\./)).toBeTruthy()
    const searching = watchSearching()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    const list = () => land(people, { ok: true, value: rosterOf([]) })
    const check = () => land(lookup, usersOf([{ id: '50', name: 'jordan' }]))
    await (first === 'people' ? list() : check())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(ROSTER_WAIT_MS)
    expect(screen.getByText(/Username check failed\./)).toBeTruthy()
    await (first === 'people' ? check() : list())
    expect(calls().people).toHaveBeenCalledTimes(2)
    expect(lookups()).toEqual(['jordan', 'jordan'])
    expect(optionTexts()).toContain('jordanNot in your repo list')
    expect(searching.stop()).toBe(0)
  })
})

describe('GPS-C5-05: a language or host label change keeps the search and its Try again', () => {
  it('keeps a held retry, its rows and both requests through both changes', async () => {
    const people = deferred<People>()
    calls().people.mockReturnValueOnce(failed()).mockReturnValueOnce(people.promise)
    calls().users.mockResolvedValue(usersOf([{ id: '50', name: 'jordan' }]))
    mountWhoCanAsk()
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    const searching = watchSearching()
    await act(async () => {
      i18n.addResourceBundle('en', 'translation', { synthetic: { sentinel: 'x' } }, true, true)
      host.relabel('Studio Mac')
      await vi.advanceTimersByTimeAsync(300 + ROSTER_WAIT_MS)
    })
    expect(optionTexts()).toContain('jordanRepos not checked')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await land(people, { ok: true, value: rosterOf([{ id: '41', login: 'maya-c', name: null }]) })
    expect(calls().people).toHaveBeenCalledTimes(2)
    expect(lookups()).toEqual(['jordan'])
    expect(optionTexts()).toContain('jordanNot in your repo list')
    expect(searching.stop()).toBe(0)
  })
})

describe('GPS-C5-07: org-only reads say org, an unknown source says GitHub list', () => {
  const orgsView = () =>
    host.publish(
      gitHubView(undefined, [{ installationId: '11', accountLogin: 'acme', repos: null }])
    )

  it('names omission, unread sources and the other reader by the org list, aged too', async () => {
    orgsView()
    calls().people.mockReturnValue(
      read({
        ...rosterOf([{ id: '41', login: 'maya-c', name: null }], {
          repositories: false,
          organizations: true
        }),
        complete: false,
        omitted: true,
        reused: true,
        readAt: new Date(2026, 10, 1, 9, 0).getTime(),
        searchedAs: 'other-reader',
        readFor: { scope: { repositories: [], owners: ['acme'], more: false }, owner: 'owner-one' }
      })
    )
    calls().users.mockResolvedValue({ ok: false, error: 'network' })
    mountWhoCanAsk()
    await typeQuery('jordan')
    const text = document.body.textContent ?? ''
    for (const line of [
      'Org list from Nov 1. Restart Orca to refresh.',
      'Not every connected org was read.',
      'Some orgs couldn’t be read.',
      'Username check failed.',
      'Orgs read as @other-reader.'
    ]) {
      expect(text).toContain(line)
    }
    expect(text).not.toMatch(/repo/i)
  })

  it('reads repos and orgs together as one GitHub list', async () => {
    calls().people.mockReturnValue(
      read({
        ...rosterOf([{ id: '41', login: 'maya-c', name: null }], {
          repositories: true,
          organizations: true
        }),
        complete: false,
        searchedAs: 'other-reader'
      })
    )
    mountWhoCanAsk()
    await typeQuery('zzqx')
    const text = document.body.textContent ?? ''
    expect(text).toContain('Some repos or orgs couldn’t be read.')
    expect(text).toContain('Read from GitHub as @other-reader.')
  })

  it('says GitHub list, with both failures, when an org scope’s list never answered', async () => {
    orgsView()
    calls().people.mockReturnValue(failed())
    calls().users.mockResolvedValue({ ok: false, error: 'network' })
    mountWhoCanAsk()
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    expect(
      screen.getByText(/Couldn’t get the GitHub list\.\s+Username check failed\./)
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/repo/i)
  })
})

describe('GPS-C5-08: the checking status under a language pack', () => {
  const packId = 'plugin:synthetic.pack/en' as const
  beforeEach(async () => {
    const pack = parsePluginLanguagePackArtifact(
      JSON.stringify({
        bots: {
          whoCanAsk: { addOne: 'Synthetic add one', selected: 'Synthetic {{count}} picked' },
          github: { whoCanAsk: { checkingUsername: 'Synthetic checking' } }
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

  it('keeps the protected status apart from the localized Add name and count', async () => {
    const exact = deferred<Users>()
    calls().people.mockReturnValue(read(rosterOf([{ id: '21', login: 'sam', name: 'Sam Ito' }])))
    calls().users.mockReturnValue(exact.promise)
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('samSam Ito')
    const button = screen.getByRole('button', { name: 'Synthetic add one' })
    expect(button).toHaveProperty('disabled', true)
    const status = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(status?.textContent).toBe('Checking a username…')
    expect(status?.getAttribute('role')).toBe('status')
    expect(screen.getByText('Synthetic 1 picked')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Synthetic checking')
  })
})

describe('GPS-C5-WIN: a host that reads no list', () => {
  it('searches exact usernames only, and its pick is granted', async () => {
    calls().people.mockResolvedValue({ ok: true, value: { status: 'exact-only' } })
    calls().users.mockResolvedValue(usersOf([{ id: '50', name: 'jordan' }]))
    mountWhoCanAsk()
    await typeQuery('jordan')
    expect(screen.getByText('Exact usernames only.')).toBeTruthy()
    pickRow('jordan')
    await clickAdd()
    expect(granted().saved).toEqual([{ id: '50', name: 'jordan' }])
  })
})

describe('GPS-D9-06: eligibility changing while the confirmation is open', () => {
  it('asks again about who is still eligible, and saves only them', async () => {
    const first = deferred<boolean>()
    calls().people.mockReturnValue(
      read(
        rosterOf([
          { id: '41', login: 'maya-c', name: 'Maya C' },
          { id: '42', login: 'lee-k', name: 'Lee K' }
        ])
      )
    )
    host.confirm.mockReturnValueOnce(first.promise).mockResolvedValue(true)
    mountWhoCanAsk()
    await settle(300)
    pickRow('lee-kLee K')
    pickRow('maya-cMaya C')
    await clickAdd()
    await act(async () => {
      host.publish(
        gitHubView([
          { userId: '1', login: 'owner-one' },
          { userId: '42', login: 'lee-k' }
        ])
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    await land(first, true)
    expect(granted()).toEqual({
      confirmed: [
        [
          { id: '42', name: 'lee-k' },
          { id: '41', name: 'maya-c' }
        ],
        [{ id: '41', name: 'maya-c' }]
      ],
      saved: [{ id: '41', name: 'maya-c' }]
    })
  })
})
