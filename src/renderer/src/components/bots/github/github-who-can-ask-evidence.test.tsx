// @vitest-environment happy-dom
// Who can ask › Add on GitHub, mounted as setup's turn-on step (production service, real list and
// grant path): identity evidence over time (a miss after a displacement, a check of an earlier
// alias, a chain of renames, a late check from a retired session) and Try again's publication,
// through the confirmation and every grant write. Synthetic data only.
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addButton,
  deferred,
  gitHubView,
  mountWhoCanAsk,
  optionTexts,
  pickRow,
  rosterOf,
  settle,
  typeQuery,
  usersOf,
  type People,
  type Users
} from './github-who-can-ask-mount'
import { ROSTER_WAIT_MS } from './github-who-can-ask-session'

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
          updates: { addMembers?: { id: string; name: string; source?: string }[] }
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
const lookups = (hostId = 'local') => calls(hostId).users.mock.calls.map(([args]) => args.query)

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

/** The held Add: disabled, its visible name kept, described by the checking status. */
async function expectNoConsentFromHeldAdd(): Promise<void> {
  expectHeld()
  fireEvent.keyDown(addButton(), { key: 'Enter' })
  await clickAdd()
  expect(host.confirm).not.toHaveBeenCalled()
}

/** Add, then hold the confirmation open: nothing is written until it is answered. */
async function consentHeld(): Promise<{ approve: () => Promise<void> }> {
  const answer = deferred<boolean>()
  host.confirm.mockReturnValueOnce(answer.promise)
  await clickAdd()
  expect(host.confirm).toHaveBeenCalledOnce()
  expect(host.update).not.toHaveBeenCalled()
  return { approve: () => land(answer, true) }
}

/** The one write's people: id, login and stamp. */
const written = () =>
  host.update.mock.calls.map(([, updates]) =>
    (updates.addMembers ?? []).map(({ id, name, source }) => ({ id, name, source }))
  )

describe('GPS-C6-01: a miss after a displacement does not make the old holder grantable', () => {
  const list = () =>
    calls().people.mockReturnValue(
      read(
        rosterOf([
          { id: '2', login: 'sam', name: 'Sam Ito' },
          { id: '41', login: 'maya-c', name: 'Maya C' }
        ])
      )
    )

  it('keeps id 2 out of the rows, the draft and every write after a later empty "sam"', async () => {
    list()
    const displaced = deferred<Users>()
    const answers = [displaced.promise, Promise.resolve(usersOf([]))]
    calls().users.mockImplementation(({ query }) =>
      query === 'sam'
        ? (answers.shift() ?? Promise.resolve(usersOf([])))
        : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('samSam Ito')
    await land(displaced, usersOf([{ id: '9', name: 'sam' }]))
    await typeQuery('maya')
    pickRow('maya-cMaya C')
    // A successful check that finds nobody named "sam" says nothing about who id 2 is.
    await typeQuery('sam')
    expect(lookups()).toEqual(['sam', 'maya', 'sam'])
    expect(optionTexts().some((text) => text.includes('Sam Ito'))).toBe(false)
    expect(screen.getByText('1 selected')).toBeTruthy()
    const consent = await consentHeld()
    expect(host.confirm.mock.calls[0]?.[0].people).toEqual([{ id: '41', name: 'maya-c' }])
    await consent.approve()
    expect(written()).toEqual([[{ id: '41', name: 'maya-c', source: 'github' }]])
  })

  it('makes id 2 pickable again only when a newer check names it, without re-ticking it', async () => {
    list()
    calls().users.mockImplementation(async ({ query }) =>
      usersOf(
        query === 'sam'
          ? [{ id: '9', name: 'sam' }]
          : query === 'sami'
            ? [{ id: '2', name: 'sami' }]
            : []
      )
    )
    mountWhoCanAsk()
    await typeQuery('sa')
    pickRow('samSam Ito')
    await typeQuery('sam')
    expect(screen.queryByText('1 selected')).toBeNull()
    await typeQuery('sami')
    expect(screen.queryByText('1 selected')).toBeNull()
    pickRow('samiSam Ito')
    const consent = await consentHeld()
    await consent.approve()
    expect(written()).toEqual([[{ id: '2', name: 'sami', source: 'github' }]])
  })

  it('an ordinary first miss leaves a listed pick as it was', async () => {
    list()
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('samSam Ito')
    expect(screen.getByText('1 selected')).toBeTruthy()
    const consent = await consentHeld()
    await consent.approve()
    expect(written()).toEqual([[{ id: '2', name: 'sam', source: 'github' }]])
  })
})

describe('GPS-C6-02: a check of a pick’s earlier login holds it', () => {
  const exactOnly = () =>
    calls().people.mockResolvedValue({ ok: true, value: { status: 'exact-only' } })

  it('serial: renamed to "mori", then "sam" rechecked: held, then consented and written as found', async () => {
    exactOnly()
    const recheck = deferred<Users>()
    calls()
      .users.mockResolvedValueOnce(usersOf([{ id: '2', name: 'sam' }]))
      .mockResolvedValueOnce(usersOf([{ id: '2', name: 'mori' }]))
      .mockReturnValueOnce(recheck.promise)
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('sam')
    await typeQuery('mori')
    await typeQuery('sam')
    await expectNoConsentFromHeldAdd()
    await land(recheck, usersOf([{ id: '2', name: 'sam' }]))
    const consent = await consentHeld()
    expect(host.confirm.mock.calls[0]?.[0].people).toEqual([{ id: '2', name: 'sam' }])
    await consent.approve()
    expect(written()).toEqual([[{ id: '2', name: 'sam', source: 'github' }]])
  })

  it('overlapping: "mori" and a "sam" recheck both out: held until both answer', async () => {
    exactOnly()
    const mori = deferred<Users>()
    const recheck = deferred<Users>()
    calls()
      .users.mockResolvedValueOnce(usersOf([{ id: '2', name: 'sam' }]))
      .mockReturnValueOnce(mori.promise)
      .mockReturnValueOnce(recheck.promise)
    mountWhoCanAsk()
    await typeQuery('sam')
    pickRow('sam')
    await typeQuery('mori')
    await typeQuery('sam')
    await land(mori, usersOf([{ id: '2', name: 'mori' }]))
    await expectNoConsentFromHeldAdd()
    await land(recheck, usersOf([{ id: '2', name: 'sam' }]))
    const consent = await consentHeld()
    expect(host.confirm.mock.calls[0]?.[0].people).toEqual([{ id: '2', name: 'sam' }])
    await consent.approve()
    expect(written()).toEqual([[{ id: '2', name: 'sam', source: 'github' }]])
  })
})

describe('GPS-C6-03: a login given away does not bring back an older alias', () => {
  it.each([
    ['in order', false],
    ['the older check finishing last', true]
  ])('%s: id 2 is neither "samuel" nor "sam" once "samuel" is id 9', async (_c, late) => {
    calls().people.mockReturnValue(read(rosterOf([{ id: '2', login: 'sam', name: 'Sam Ito' }])))
    const first = deferred<Users>()
    let asked = 0
    calls().users.mockImplementation(({ query }) => {
      if (query !== 'samuel') {
        return Promise.resolve(usersOf([]))
      }
      asked += 1
      // The first check of "samuel" names id 2; every later one names id 9.
      return asked === 1 && late
        ? first.promise
        : Promise.resolve(usersOf([{ id: asked === 1 ? '2' : '9', name: 'samuel' }]))
    })
    mountWhoCanAsk()
    await typeQuery('samuel')
    if (!late) {
      pickRow('samuelSam Ito')
    }
    await typeQuery('x')
    await typeQuery('samuel')
    if (late) {
      await land(first, usersOf([{ id: '2', name: 'samuel' }]))
    }
    // Before any other query: only id 9 is offered, and nothing is picked.
    expect(optionTexts().filter((text) => text.startsWith('sam'))).toEqual([
      'samuelNot in your repo list'
    ])
    expect(screen.queryByText(/selected$/)).toBeNull()
    await typeQuery('sam')
    expect(optionTexts().some((text) => text.includes('Sam Ito'))).toBe(false)
    await typeQuery('samuel')
    pickRow('samuelNot in your repo list')
    const consent = await consentHeld()
    await consent.approve()
    expect(written()).toEqual([[{ id: '9', name: 'samuel', source: 'github' }]])
  })
})

describe('GPS-C6-05: a late check from a retired session re-ranks the active query', () => {
  const refresh = async (): Promise<void> => {
    await act(async () => {
      host.publish(
        gitHubView(undefined, [{ installationId: '12', accountLogin: 'acme', repos: ['acme/api'] }])
      )
      await vi.advanceTimersByTimeAsync(300)
    })
  }

  it('fills the 30-row cut when an earlier session’s check displaces a shown row', async () => {
    const people = Array.from({ length: 31 }, (_, index) => ({
      id: String(100 + index),
      login: `p${String(index).padStart(2, '0')}`,
      name: null
    }))
    calls().people.mockReturnValue(read(rosterOf(people)))
    const late = deferred<Users>()
    calls().users.mockImplementation(({ query }) =>
      query === 'p00' && calls().users.mock.calls.length === 1
        ? late.promise
        : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('p00')
    await typeQuery('p')
    await refresh()
    expect(optionTexts()).toContain('p00')
    expect(optionTexts()).not.toContain('p30')
    const asked = { people: calls().people.mock.calls.length, users: lookups().length }
    await land(late, usersOf([{ id: '999', name: 'p00' }]))
    expect(optionTexts()).not.toContain('p00')
    expect(optionTexts()).toContain('p30')
    expect({ people: calls().people.mock.calls.length, users: lookups().length }).toEqual(asked)
  })

  it('drops a row whose renamed login no longer matches, and shows one that now does', async () => {
    calls().people.mockReturnValue(
      read(
        rosterOf([
          { id: '23', login: 'jo', name: null },
          { id: '24', login: 'kim', name: null }
        ])
      )
    )
    const late = deferred<Users>()
    calls().users.mockImplementation(({ query }) =>
      query === 'kai' ? late.promise : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('kai')
    await typeQuery('jo')
    await refresh()
    expect(optionTexts()).toContain('jo')
    const asked = { people: calls().people.mock.calls.length, users: lookups().length }
    await land(late, usersOf([{ id: '23', name: 'kai' }]))
    expect(optionTexts()).not.toContain('jo')
    expect(optionTexts()).not.toContain('kai')
    await typeQuery('ka')
    expect(optionTexts()).toContain('kai')
    expect(calls().people.mock.calls.length).toBe(asked.people)
  })
})

describe('GPS-C6-06: an answer already on its way does not paint over Try again', () => {
  it.each([
    ['the list first', 'list'],
    ['the lookup first', 'lookup']
  ])('%s: the held Try again paints only its own whole answer', async (_c, first) => {
    const roster = deferred<People>()
    const zed = deferred<Users>()
    const again = deferred<Users>()
    calls().people.mockReturnValue(roster.promise)
    calls()
      .users.mockReturnValueOnce(zed.promise)
      .mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockReturnValueOnce(again.promise)
    mountWhoCanAsk()
    await typeQuery('zed')
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    // The list still loading and the lookup failed: nothing final yet, and Try again is offered.
    expect(screen.getByText('Still loading your repos')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    // An earlier query's lookup lands: an ordinary search for "jordan" goes out, waiting on the list.
    await land(zed, usersOf([]))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const list = () => land(roster, { ok: true, value: rosterOf([]) })
    const lookup = () => land(again, usersOf([{ id: '50', name: 'jordan' }]))
    await (first === 'list' ? list() : lookup())
    await settle(ROSTER_WAIT_MS)
    // Still the answer Try again was pressed on, not the earlier search's answer to the list.
    expect(screen.getByText('Still loading your repos')).toBeTruthy()
    expect(screen.queryByText(/No one found/)).toBeNull()
    await (first === 'list' ? lookup() : list())
    expect(optionTexts()).toContain('jordanNot in your repo list')
    expect(screen.queryByText(/Username check failed\./)).toBeNull()
    expect(screen.queryByText('Still loading your repos')).toBeNull()
    expect(calls().people).toHaveBeenCalledOnce()
    expect(lookups()).toEqual(['zed', 'jordan', 'jordan'])
  })
})
