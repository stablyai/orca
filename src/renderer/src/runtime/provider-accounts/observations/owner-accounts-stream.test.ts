// The usage bar emptied on every host switch: an unsubscribed host's stream reopened at `state:
// null`, so the bar showed pending snapshots until the host answered again. The last snapshot a
// host vouched for must survive the unsubscribe teardown. (#48456)
import { describe, expect, it, vi } from 'vitest'

import type { ProviderAccountsSnapshot } from './runtime-provider-accounts-client'
import { watchProviderAccounts } from './runtime-provider-accounts-client'

vi.mock('./runtime-provider-accounts-client', () => ({
  watchProviderAccounts: vi.fn(() => ({ close: vi.fn() }))
}))

import { readOwnerAccounts, subscribeOwnerAccounts } from './owner-accounts-stream'

const SNAPSHOT: ProviderAccountsSnapshot = {
  claude: {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  },
  codex: {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  },
  rateLimits: null
}

type Handlers = { onSnapshot: (s: ProviderAccountsSnapshot) => void }

function lastWatcher(): Handlers {
  const handlers = vi.mocked(watchProviderAccounts).mock.calls.at(-1)?.[1]
  if (!handlers) {
    throw new Error('watchProviderAccounts was not called')
  }
  return handlers
}

describe('owner accounts stream remembers a host across unsubscribes', () => {
  it('reopens with the host’s last vouched-for snapshot instead of an empty bar', () => {
    const env = 'env-a'
    const off1 = subscribeOwnerAccounts(env, () => {})
    lastWatcher().onSnapshot(SNAPSHOT)
    off1()

    const off2 = subscribeOwnerAccounts(env, () => {})
    expect(readOwnerAccounts(env)?.snapshot).toBe(SNAPSHOT)
    off2()
  })
})
