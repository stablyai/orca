import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY,
  GOOGLE_CONNECT_RUNTIME_CAPABILITY
} from '../../../../../shared/google/google-connect-types'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { botErrorMessage } from '../bot-presentation'
import { setBotGoogle } from './set-bot-google'

// `old` is a host from before account choice (v1.4.273); both have two accounts signed in.
const hosts: Record<string, readonly string[]> = {
  old: [GOOGLE_CONNECT_RUNTIME_CAPABILITY],
  new: [GOOGLE_CONNECT_RUNTIME_CAPABILITY, GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY]
}
const calls: { method: string; params: unknown }[] = []

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async (environmentId: string, capability: string) =>
    hosts[environmentId]?.includes(capability) === true
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: unknown) => {
    calls.push({ method, params })
    return method === 'google.status'
      ? {
          client: null,
          accounts: [{ email: 'Me@Work.com' }, { email: 'me@gmail.com' }],
          bots: []
        }
      : {}
  }
}))

const bot = (host: string) => ({ id: 'scout', hostId: toRuntimeExecutionHostId(host) })
const sets = () => calls.filter((call) => call.method === 'google.bot.set').map((c) => c.params)

beforeEach(() => {
  calls.length = 0
})

describe('setBotGoogle', () => {
  it('sends an older host plain on when every account there is chosen', async () => {
    await setBotGoogle(bot('old'), true, { accounts: ['me@work.com', 'me@gmail.com'] })
    expect(sets()).toEqual([{ botId: 'scout', on: true, allAccounts: true }])
  })

  it('refuses a subset on an older host, sending it nothing', async () => {
    const saving = setBotGoogle(bot('old'), true, { accounts: ['me@gmail.com'] })
    const error = await saving.catch((caught: unknown) => caught)
    expect(botErrorMessage(error)).toMatch(/^Update Orca on .+ to choose accounts\.$/)
    expect(sets()).toEqual([])
  })

  it('sends the list to a host that keeps it', async () => {
    await setBotGoogle(bot('new'), true, { accounts: ['me@gmail.com'], confirmedAskers: [] })
    expect(sets()).toEqual([
      { botId: 'scout', on: true, accounts: ['me@gmail.com'], confirmedAskers: [] }
    ])
  })
})
