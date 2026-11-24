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
/** A distro read: the focused WSL host's own selected-account reading, not the host runtime's. */
const wslUsage: ProviderRateLimits = {
  ...usage,
  session: {
    usedPercent: 62,
    windowMinutes: 300,
    resetsAt: Date.now() + 3600000,
    resetDescription: null
  }
}
type FixtureOptions = {
  /** The selected account still lists a login, but its usage read reports it signed out. */
  signInAgain?: boolean
  /** Press the card's Sign in button and hold the sign-in open. */
  busy?: boolean
}
const SIGN_IN_AGAIN_EMAILS: Record<string, string> = {
  selected: 'alex@example.com',
  usable: 'sam@example.com',
  stale: 'riley@example.com',
  team: 'jordan@example.com'
}
function fixture(
  width = 520,
  wsl = false,
  { signInAgain = false, busy = false }: FixtureOptions = {}
) {
  const account = (
    id: string,
    extra: Partial<ClaudeManagedAccountSummary> = {}
  ): ClaudeManagedAccountSummary => ({
    id,
    email: signInAgain ? SIGN_IN_AGAIN_EMAILS[id] : 'jinjing@example.com',
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
    account('selected', signInAgain ? {} : { needsSignIn: true }),
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
        claude: wsl ? wslUsage : claude,
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
      // Why never settle: the busy capture holds the sign-in mid-flight.
      window.api.claudeAccounts.reauthenticate = () => new Promise(() => {})
    },
    render: () => (
      <div className="flex h-[720px] items-end bg-background p-3">
        <ClaudeSwitcherForOwner
          claude={wsl ? wslUsage : claude}
          iconOnly={false}
          owner={{ target: { kind: 'local' }, wslHostDistro: wsl ? 'Ubuntu' : null }}
          ownerUsage={{
            owner: { target: { kind: 'local' }, wslHostDistro: wsl ? 'Ubuntu' : null },
            rateLimits: useAppStore.getState().rateLimits,
            accounts: null,
            // Why: the hook reports a WSL owner as this desktop standing in for the distro.
            remoteOwner: wsl
              ? { environmentId: null, wslDistro: 'Ubuntu', label: 'WSL Ubuntu' }
              : null,
            refreshRemote: wsl ? async () => {} : null
          }}
        />
      </div>
    ),
    interact: async (frame) => {
      frame
        .querySelector<HTMLButtonElement>('button[aria-label]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      if (!busy) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      document
        .querySelector<HTMLButtonElement>('[role="menu"] button[aria-label^="Sign in: alex"]')
        ?.click()
    }
  })
}
export const duplicate = fixture()
export const narrow = fixture(360)
export const wsl = fixture(520, true)
export const signInAgain = fixture(520, false, { signInAgain: true })
export const signInAgainBusy = fixture(520, false, { signInAgain: true, busy: true })
