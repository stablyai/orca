// @vitest-environment happy-dom
// Who can ask › Add on GitHub, mounted as setup's turn-on step (production service, real list and
// grant path): checks the picker had asked that settle while the grant's confirmation is open,
// through every confirmation and every write, in setup and in Settings. Synthetic data only.
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addButton,
  bot,
  deferred,
  gitHubView,
  mountSettingsWhoCanAsk,
  mountWhoCanAsk,
  pickRow,
  rosterOf,
  settle,
  typeQuery,
  usersOf,
  type People,
  type Users
} from './github-who-can-ask-mount'
import { ROSTER_WAIT_MS } from './github-who-can-ask-session'
import { BOT_MAX_MEMBERS, type Bot } from '../../../../../shared/bot-types'
import { applyBotUpdates } from '../../../../../shared/rpc-contract/bots-params'

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
    update: vi.fn<
      (
        bot: unknown,
        updates: {
          addMembers?: { id: string; name: string; source?: string; workspaceId?: string }[]
        }
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

// Sends that got past updateBot's optimistic apply; a refused one never gets here.
const sent = vi.fn()
const fullBot: Bot = {
  ...bot,
  members: Array.from({ length: BOT_MAX_MEMBERS }, (_, index) => ({
    id: `U${index}`,
    name: `member-${index}`
  }))
}
/** The next write is refused the way updateBot refuses it, before any request goes out: its
 *  optimistic apply against a bot already full throws the capacity error. */
function refuseFirstWriteAsFull(): void {
  sent.mockClear()
  host.update.mockImplementationOnce(async (_bot, updates) => {
    applyBotUpdates(fullBot, updates)
    sent()
    return undefined
  })
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

/** Every confirmation's people, and every write's people with their stamp. */
const asked = () => host.confirm.mock.calls.map(([grant]) => grant.people)
const stamped = () =>
  host.update.mock.calls.map(([, updates]) =>
    (updates.addMembers ?? []).map(({ id, name, source, workspaceId }) => ({
      id,
      name,
      source,
      ...(workspaceId ? { workspaceId } : {})
    }))
  )
const heldAnswer = () => {
  const answer = deferred<boolean>()
  host.confirm.mockReturnValueOnce(answer.promise)
  return answer
}

describe('GPS-C8-01: checks settling while the confirmation is open', () => {
  it('the list lands first and makes a pending check about this pick: waits, then asks again', async () => {
    const roster = deferred<People>()
    const lee = deferred<Users>()
    calls().people.mockReturnValue(roster.promise)
    calls().users.mockImplementation(({ query }) =>
      query === 'jordan'
        ? Promise.resolve(usersOf([{ id: '50', name: 'jordan' }]))
        : query === 'lee'
          ? lee.promise
          : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    pickRow('jordanRepos still loading')
    // Not about this pick yet: nothing says "Lee" is who they are.
    await typeQuery('lee')
    expect(addButton()).toHaveProperty('disabled', false)
    const first = heldAnswer()
    await clickAdd()
    // While the confirmation is open, the list lands: this person's real name is Jordan Lee.
    await land(roster, {
      ok: true,
      value: rosterOf([{ id: '50', login: 'jordan', name: 'Jordan Lee' }])
    })
    await land(first, true)
    // Approved, but the "lee" check could now change who this is: nothing is written yet.
    expect(asked()).toEqual([[{ id: '50', name: 'jordan' }]])
    expect(host.update).not.toHaveBeenCalled()
    const second = heldAnswer()
    await land(lee, usersOf([{ id: '50', name: 'lee' }]))
    expect(asked()).toEqual([[{ id: '50', name: 'jordan' }], [{ id: '50', name: 'lee' }]])
    expect(host.update).not.toHaveBeenCalled()
    await land(second, true)
    expect(stamped()).toEqual([[{ id: '50', name: 'lee', source: 'github' }]])
  })

  const lookupFirst = async () => {
    calls().people.mockReturnValue(read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }])))
    const jordy = deferred<Users>()
    calls().users.mockImplementation(({ query }) =>
      query === 'jordan'
        ? Promise.resolve(usersOf([{ id: '50', name: 'jordan' }]))
        : query === 'jordy'
          ? jordy.promise
          : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('jordan')
    pickRow('jordanNot in your repo list')
    await typeQuery('maya')
    pickRow('maya-cMaya C')
    // A check that isn't about either pick: Add stays usable.
    await typeQuery('jordy')
    expect(addButton()).toHaveProperty('disabled', false)
    const first = heldAnswer()
    await clickAdd()
    // While the confirmation is open, that check finds id 50 under a new login.
    await land(jordy, usersOf([{ id: '50', name: 'jordy' }]))
    return first
  }

  it('a check names a pick under a new login while it is open: asks again under that login', async () => {
    const first = await lookupFirst()
    const second = heldAnswer()
    await land(first, true)
    expect(asked()).toEqual([
      [
        { id: '50', name: 'jordan' },
        { id: '41', name: 'maya-c' }
      ],
      [
        { id: '50', name: 'jordy' },
        { id: '41', name: 'maya-c' }
      ]
    ])
    expect(host.update).not.toHaveBeenCalled()
    await land(second, true)
    expect(stamped()).toEqual([
      [
        { id: '50', name: 'jordy', source: 'github' },
        { id: '41', name: 'maya-c', source: 'github' }
      ]
    ])
  })

  it('a cancelled confirmation writes nothing, whatever settles after', async () => {
    const first = await lookupFirst()
    await land(first, false)
    await settle(ROSTER_WAIT_MS)
    expect(asked()).toHaveLength(1)
    expect(host.update).not.toHaveBeenCalled()
  })

  it('in Settings, the write carries the installation', async () => {
    calls().people.mockReturnValue(read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }])))
    mountSettingsWhoCanAsk('11')
    await settle(300)
    pickRow('maya-cMaya C')
    const answer = heldAnswer()
    await clickAdd()
    expect(host.update).not.toHaveBeenCalled()
    await land(answer, true)
    expect(stamped()).toEqual([[{ id: '41', name: 'maya-c', source: 'github', workspaceId: '11' }]])
  })
})

describe('GPS-C9-01: who is written is decided right before each write', () => {
  it('an owner linked while a check is awaited after approval: asks again for the rest only', async () => {
    const roster = deferred<People>()
    const lee = deferred<Users>()
    calls().people.mockReturnValue(roster.promise)
    calls().users.mockImplementation(({ query }) =>
      query === 'jordan'
        ? Promise.resolve(usersOf([{ id: '50', name: 'jordan' }]))
        : query === 'maya-c'
          ? Promise.resolve(usersOf([{ id: '41', name: 'maya-c' }]))
          : query === 'lee'
            ? lee.promise
            : Promise.resolve(usersOf([]))
    )
    mountWhoCanAsk()
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    pickRow('jordanRepos still loading')
    await typeQuery('maya-c', 300 + ROSTER_WAIT_MS)
    pickRow('maya-cRepos still loading')
    await typeQuery('lee')
    const first = heldAnswer()
    await clickAdd()
    // The list lands during the confirmation: the "lee" check is now about Jordan Lee.
    await land(roster, {
      ok: true,
      value: rosterOf([{ id: '50', login: 'jordan', name: 'Jordan Lee' }])
    })
    await land(first, true)
    // While that check is awaited, Maya's account is linked as the owner's.
    await act(async () => {
      host.publish(
        gitHubView([
          { userId: '1', login: 'owner-one' },
          { userId: '41', login: 'maya-c' }
        ])
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(host.update).not.toHaveBeenCalled()
    const second = heldAnswer()
    // The check finds no one named "lee": Jordan is unchanged, Maya is no longer eligible.
    await land(lee, usersOf([]))
    expect(asked()).toEqual([
      [
        { id: '50', name: 'jordan' },
        { id: '41', name: 'maya-c' }
      ],
      [{ id: '50', name: 'jordan' }]
    ])
    expect(host.update).not.toHaveBeenCalled()
    await land(second, true)
    expect(stamped()).toEqual([[{ id: '50', name: 'jordan', source: 'github' }]])
  })

  const refusedThenRenamed = async (renamed: boolean) => {
    calls().people.mockReturnValue(read(rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }])))
    const jordy = deferred<Users>()
    calls().users.mockImplementation(({ query }) =>
      query === 'jordan'
        ? Promise.resolve(usersOf([{ id: '50', name: 'jordan' }]))
        : query === 'jordy'
          ? jordy.promise
          : Promise.resolve(usersOf([]))
    )
    refuseFirstWriteAsFull()
    mountSettingsWhoCanAsk('11')
    await typeQuery('jordan')
    pickRow('jordanNot in your repo list')
    // A check that isn't about the pick: Add goes ahead.
    await typeQuery('jordy')
    await clickAdd()
    expect(host.update).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('Nobody was added')
    // After the refusal, that check finds id 50 under a new login (or nothing at all).
    await land(jordy, usersOf(renamed ? [{ id: '50', name: 'jordy' }] : []))
  }

  it('a refused save’s Try again asks again under the new login, then writes it once', async () => {
    await refusedThenRenamed(true)
    const again = heldAnswer()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked()).toEqual([[{ id: '50', name: 'jordan' }], [{ id: '50', name: 'jordy' }]])
    expect(host.update).toHaveBeenCalledOnce()
    await land(again, true)
    expect(stamped()).toEqual([
      [{ id: '50', name: 'jordan', source: 'github', workspaceId: '11' }],
      [{ id: '50', name: 'jordy', source: 'github', workspaceId: '11' }]
    ])
  })

  it('a refused save’s Try again with nothing changed writes the same people, without asking', async () => {
    await refusedThenRenamed(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked()).toHaveLength(1)
    expect(stamped()).toEqual([
      [{ id: '50', name: 'jordan', source: 'github', workspaceId: '11' }],
      [{ id: '50', name: 'jordan', source: 'github', workspaceId: '11' }]
    ])
  })
})

describe('a failed save’s Try again acts once, on its first press', () => {
  /** A save refused before sending (capacity), then a check that is about the pick still out. */
  async function refusedWithCheckOut(): Promise<{ lee: ReturnType<typeof deferred<Users>> }> {
    const roster = deferred<People>()
    const lee = deferred<Users>()
    calls().people.mockReturnValue(roster.promise)
    calls().users.mockImplementation(({ query }) =>
      query === 'jordan'
        ? Promise.resolve(usersOf([{ id: '50', name: 'jordan' }]))
        : query === 'lee'
          ? lee.promise
          : Promise.resolve(usersOf([]))
    )
    refuseFirstWriteAsFull()
    mountSettingsWhoCanAsk('11')
    await typeQuery('jordan', 300 + ROSTER_WAIT_MS)
    pickRow('jordanRepos still loading')
    await typeQuery('lee')
    await clickAdd()
    expect(screen.getByRole('alert').textContent).toContain('Nobody was added')
    expect(sent).not.toHaveBeenCalled()
    // The list lands: the "lee" check is now about this person, and still out.
    await land(roster, {
      ok: true,
      value: rosterOf([{ id: '50', login: 'jordan', name: 'Jordan Lee' }])
    })
    // Try again, pressed twice on the same offer.
    const retry = screen.getByRole('button', { name: 'Try again' })
    await act(async () => {
      fireEvent.click(retry)
      fireEvent.click(retry)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(host.update).toHaveBeenCalledOnce()
    return { lee }
  }

  it('renamed meanwhile: one renewed confirmation, then one write', async () => {
    const { lee } = await refusedWithCheckOut()
    await land(lee, usersOf([{ id: '50', name: 'lee' }]))
    await settle()
    expect(asked()).toEqual([[{ id: '50', name: 'jordan' }], [{ id: '50', name: 'lee' }]])
    expect(stamped()).toEqual([
      [{ id: '50', name: 'jordan', source: 'github', workspaceId: '11' }],
      [{ id: '50', name: 'lee', source: 'github', workspaceId: '11' }]
    ])
  })

  it('unchanged: one write, with no new confirmation', async () => {
    const { lee } = await refusedWithCheckOut()
    await land(lee, usersOf([]))
    await settle()
    expect(asked()).toHaveLength(1)
    expect(stamped()).toEqual([
      [{ id: '50', name: 'jordan', source: 'github', workspaceId: '11' }],
      [{ id: '50', name: 'jordan', source: 'github', workspaceId: '11' }]
    ])
  })

  it('the renewed confirmation cancelled: the attempt ends, nothing written, nothing else asked', async () => {
    const { lee } = await refusedWithCheckOut()
    host.confirm.mockResolvedValueOnce(false)
    await land(lee, usersOf([{ id: '50', name: 'lee' }]))
    await settle(ROSTER_WAIT_MS)
    expect(asked()).toHaveLength(2)
    expect(host.update).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a later failure offers its own Try again, which writes', async () => {
    const { lee } = await refusedWithCheckOut()
    host.update.mockRejectedValueOnce(new Error('network'))
    await land(lee, usersOf([]))
    await settle()
    expect(host.update).toHaveBeenCalledTimes(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stamped()).toHaveLength(3)
    expect(stamped()[2]).toEqual([
      { id: '50', name: 'jordan', source: 'github', workspaceId: '11' }
    ])
  })
})
