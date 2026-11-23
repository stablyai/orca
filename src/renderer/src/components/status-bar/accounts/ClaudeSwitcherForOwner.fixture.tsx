import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ClaudeSwitcherForOwner } from './ClaudeSwitcherForOwner'
import { useAppStore } from '../../../store/index'

const claude: ProviderRateLimits = {
  provider: 'claude',
  status: 'error',
  error: 'The selected Claude account needs to sign in again.',
  usageMetadata: { failureKind: 'missing-credentials', attemptedSources: [] },
  session: null,
  weekly: null,
  updatedAt: Date.now()
}
const usage: ProviderRateLimits = {
  ...claude,
  status: 'ok',
  error: null,
  weekly: {
    usedPercent: 15,
    windowMinutes: 10080,
    resetsAt: Date.now() + 86400000,
    resetDescription: null
  }
}
function fixture(width = 520, wsl = false) {
  const account = (
    id: string,
    extra: Partial<ClaudeManagedAccountSummary> = {}
  ): ClaudeManagedAccountSummary => ({
    id,
    email: 'jinjing@example.com',
    organizationUuid: 'org-a1b2',
    organizationName: 'Acme',
    managedAuthRuntime: wsl ? 'wsl' : 'host',
    wslDistro: wsl ? 'Ubuntu' : null,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  })
  const accounts = [
    account('selected', { needsSignIn: true }),
    account('usable', { updatedAt: 3 }),
    account('stale', { needsSignIn: true }),
    account('team', { organizationUuid: 'org-c3d4', organizationName: null })
  ]
  const state: ClaudeRateLimitAccountsState = {
    accounts,
    activeAccountId: wsl ? null : 'selected',
    activeAccountIdsByRuntime: {
      host: wsl ? null : 'selected',
      wsl: wsl ? { Ubuntu: 'selected' } : {}
    }
  }
  return defineFixture({
    width,
    store: {
      settings: {
        ...getDefaultSettings('/home/fixture'),
        claudeManagedAccounts: accounts.map((a) => ({
          ...a,
          managedAuthPath: `/home/fixture/${a.id}`
        })),
        activeClaudeManagedAccountId: state.activeAccountId,
        activeClaudeManagedAccountIdsByRuntime: state.activeAccountIdsByRuntime!
      },
      rateLimits: createEmptyRateLimitState({
        claude,
        claudeTarget: wsl
          ? { runtime: 'wsl', wslDistro: 'Ubuntu' }
          : { runtime: 'host', wslDistro: null },
        inactiveClaudeAccounts: [
          { accountId: 'usable', rateLimits: usage, updatedAt: Date.now(), isFetching: false }
        ]
      }),
      fetchInactiveClaudeAccountUsage: async () => {}
    },
    setup: () => {
      window.api.claudeAccounts.list = async () => state
      window.api.codexAccounts.list = async () => ({ accounts: [], activeAccountId: null })
    },
    render: () => (
      <div className="flex h-[720px] items-end bg-background p-3">
        <ClaudeSwitcherForOwner
          claude={claude}
          iconOnly={false}
          owner={{ target: { kind: 'local' }, wslHostDistro: wsl ? 'Ubuntu' : null }}
          ownerUsage={{
            owner: { target: { kind: 'local' }, wslHostDistro: wsl ? 'Ubuntu' : null },
            rateLimits: useAppStore.getState().rateLimits,
            accounts: null,
            remoteOwner: null,
            refreshRemote: null
          }}
        />
      </div>
    ),
    interact: (frame) => {
      frame
        .querySelector<HTMLButtonElement>('button[aria-label]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    }
  })
}
export const duplicate = fixture()
export const narrow = fixture(360)
export const wsl = fixture(520, true)
