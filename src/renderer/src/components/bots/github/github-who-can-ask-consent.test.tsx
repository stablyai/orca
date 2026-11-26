// @vitest-environment happy-dom
// Who can ask › Add on GitHub, mounted as setup's turn-on step (production service, real list and
// grant path): checks the picker had asked that settle while the grant's confirmation is open,
// through every confirmation and every write, in setup and in Settings. Synthetic data only.
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addButton,
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
