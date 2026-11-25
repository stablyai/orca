import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { CodexManagedAccount } from '../../../../../shared/agent-accounts/managed-account-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { useAppStore } from '@/store'
import { Toaster } from '@/components/ui/sonner'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'
import {
  useAccountOwnerUsage,
  type OwnerUsageRateLimits
} from '../usage/use-owner-usage-rate-limits'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

type SampleAccount = {
  id: string
  email: string
  workspace: string | null
  /** Weekly used percent; null when usage is unavailable. */
  weekly: number | null
  error?: string
  resetsInDays: number
  wslDistro?: string
}

const BASE_ACCOUNTS: SampleAccount[] = [
  {
    id: 'echo0001',
    email: 'echo@example.com',
    workspace: 'Personal (Pro)',
    weekly: 100,
    resetsInDays: 6
  },
  {
    id: '2cdb7eb6',
    email: 'jinjing@example.com',
    workspace: 'Personal (Pro)',
    weekly: 38,
    resetsInDays: 3
  },
  {
    id: '9a41e0d3',
    email: 'jinjing@example.com',
    workspace: 'Team',
    weekly: 12,
    resetsInDays: 6
  },
  {
    id: 'foxt0001',
    email: 'foxtrot@example.com',
    workspace: 'Personal (Pro)',
    weekly: 60,
    resetsInDays: 1
  },
  {
    id: 'indi0001',
    email: 'india@example.com',
    workspace: 'Personal (Pro)',
    weekly: 0,
    resetsInDays: 6
  },
  {
    id: 'neil0001',
    email: 'neil@example.com',
    workspace: null,
    weekly: null,
    resetsInDays: 0
  }
]

const EXTRA_ACCOUNTS: SampleAccount[] = [
  ['alpha', 76],
  ['bravo', 22],
  ['charlie', 100],
  ['delta', 5],
  ['golf', 44],
  ['hotel', 91]
].map(([name, weekly], index) => ({
  id: `${name}0001`,
  email: `${name}@example.com`,
  workspace: index === 1 ? 'Team' : 'Personal (Pro)',
  weekly: Number(weekly),
  resetsInDays: (index % 5) + 1
}))

function weeklyWindow(usedPercent: number, resetsInDays: number): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes: 10_080,
    resetsAt: NOW + resetsInDays * DAY + 5 * 60 * 60 * 1000,
    resetDescription: null
  }
}

function usageFor(account: SampleAccount, weeklyOnly = false): ProviderRateLimits {
  return {
    provider: 'codex',
    session:
      account.weekly === null || weeklyOnly
        ? null
        : {
            usedPercent: 32,
            windowMinutes: 300,
            resetsAt: NOW + 80 * 60_000 + 5_000,
            resetDescription: null
          },
    weekly: account.weekly === null ? null : weeklyWindow(account.weekly, account.resetsInDays),
    updatedAt: NOW - 60_000,
    error: account.weekly === null ? (account.error ?? 'Not signed in') : null,
    status: account.weekly === null ? 'error' : 'ok',
    usageMetadata: account.error
      ? {
          authFailureAccount: {
            accountId: account.id,
            runtime: account.wslDistro ? 'wsl' : 'host',
            wslDistro: account.wslDistro ?? null
          }
        }
      : undefined
  }
}

function managed(account: SampleAccount): CodexManagedAccount {
  return {
    id: account.id,
    email: account.email,
    managedHomePath: `/home/me/.orca/codex/${account.id}`,
    managedHomeRuntime: account.wslDistro ? 'wsl' : 'host',
    wslDistro: account.wslDistro ?? null,
    providerAccountId: `provider-${account.id}`,
    workspaceLabel: account.workspace,
    workspaceAccountId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastAuthenticatedAt: NOW
  }
}

function FixtureSwitcher(props: React.ComponentProps<typeof CodexSwitcherMenu>) {
  const rateLimits = useAppStore((state) => state.rateLimits)
  const local = useAccountOwnerUsage({ target: { kind: 'local' }, wslHostDistro: null }, rateLimits)
  if (props.ownerUsage.owner?.target.kind !== 'local' || !local.rateLimits.codex) {
    return <CodexSwitcherMenu {...props} />
  }
  return <CodexSwitcherMenu {...props} codex={local.rateLimits.codex} ownerUsage={local} />
}

function switcherFixture(
  accounts: SampleAccount[],
  asSubmenu = false,
  staleRestart = false,
  systemDefaultOnly = false,
  remote = false
) {
  const [active, ...inactive] = accounts
  const codex: ProviderRateLimits = {
    ...usageFor(active, remote),
    rateLimitResetCredits: { availableCount: 1, nextExpiresAt: NOW + 29 * DAY }
  }
  const inactiveCodexAccounts: InactiveAccountUsage[] = inactive.map((account) => ({
    accountId: account.id,
    rateLimits: usageFor(account, remote),
    updatedAt: NOW - 60_000,
    isFetching: false
  }))
  const rateLimits = createEmptyRateLimitState({ codex, inactiveCodexAccounts })
  const snapshot = {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: accounts.map(managed), activeAccountId: active.id },
    rateLimits
  }
  const ownerUsage: OwnerUsageRateLimits = remote
    ? {
        owner: { target: { kind: 'environment', environmentId: 'laptop' }, wslHostDistro: null },
        rateLimits,
        accounts: snapshot,
        remoteOwner: { environmentId: 'laptop', label: 'Laptop' },
        refreshRemote: null
      }
    : {
        owner: { target: { kind: 'local' }, wslHostDistro: null },
        rateLimits,
        accounts: null,
        remoteOwner: null,
        refreshRemote: null
      }
  return defineFixture({
    width: 520,
    store: {
      settings: {
        ...getDefaultSettings('/home/me'),
        activeRuntimeEnvironmentId: remote ? 'laptop' : null,
        codexManagedAccounts: systemDefaultOnly ? [] : accounts.map(managed),
        activeCodexManagedAccountId: systemDefaultOnly ? null : active.id,
        activeCodexManagedAccountIdsByRuntime: {
          host: systemDefaultOnly ? null : active.id,
          wsl: {}
        }
      },
      rateLimits: remote
        ? createEmptyRateLimitState({
            codex: { ...codex, weekly: weeklyWindow(99, 1) },
            codexTarget: { runtime: 'host', wslDistro: null }
          })
        : rateLimits,
      ...(staleRestart
        ? {
            tabsByWorktree: { wt1: [makeTab({ id: 'tab1', worktreeId: 'wt1' })] },
            ptyIdsByTabId: { tab1: ['pty1'] },
            codexRestartNoticeByPtyId: {
              pty1: {
                previousAccountLabel: 'echo@example.com',
                nextAccountLabel: 'jinjing@example.com'
              }
            }
          }
        : {}),
      fetchInactiveCodexAccountUsage: async () => {},
      fetchSettings: async () => {}
    },
    setup: () => {
      // Settings already carry the roster; the web bridge has no local account IPC to answer.
      window.api.codexAccounts.list = async () => ({ accounts: [], activeAccountId: null })
      window.api.claudeAccounts.list = async () => ({ accounts: [], activeAccountId: null })
      if (remote) {
        window.api.runtimeEnvironments.subscribe = async (_request, handlers) => {
          queueMicrotask(() =>
            handlers.onResponse({
              id: 'fixture',
              ok: true,
              _meta: { runtimeId: 'laptop' },
              result: { type: 'ready', snapshot }
            })
          )
          return { unsubscribe: () => {}, sendBinary: () => true }
        }
      }
    },
    render: () => (
      <div className="flex h-[760px] items-end bg-background p-3">
        {asSubmenu ? (
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
            <DropdownMenuContent>
              <FixtureSwitcher
                codex={codex}
                ownerUsage={ownerUsage}
                asSubmenu
                triggerContent="Codex"
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <FixtureSwitcher codex={codex} ownerUsage={ownerUsage} />
        )}
        <Toaster />
      </div>
    ),
    interact: async (frame) => {
      if (remote) {
        await setRendererUiLanguage('en')
      }
      if (asSubmenu) {
        const trigger = frame.ownerDocument.querySelector<HTMLElement>(
          '[data-slot="dropdown-menu-sub-trigger"]'
        )
        trigger?.focus()
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        return
      }
      frame
        .querySelector<HTMLButtonElement>('button[aria-label]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    }
  })
}

export const sixAccounts = switcherFixture(BASE_ACCOUNTS)

export const systemDefaultOnly = switcherFixture(BASE_ACCOUNTS.slice(1, 2), false, false, true)

export const staleSession = switcherFixture(BASE_ACCOUNTS, false, true)

export const longList = switcherFixture([...BASE_ACCOUNTS, ...EXTRA_ACCOUNTS])

export const submenu = switcherFixture([...BASE_ACCOUNTS, ...EXTRA_ACCOUNTS], true)

export const transientUsageFailures = switcherFixture([
  ...BASE_ACCOUNTS.slice(0, 2),
  { ...BASE_ACCOUNTS[2], weekly: null, error: 'Sign-in probe timed out' },
  { ...BASE_ACCOUNTS[3], weekly: null, error: 'Session index rebuilding' }
])

export const pairedHost = switcherFixture(BASE_ACCOUNTS.slice(0, 5), false, false, false, true)

export const pairedHostWithWsl = switcherFixture(
  [...BASE_ACCOUNTS.slice(0, 5), { ...BASE_ACCOUNTS[0], id: 'linux', wslDistro: 'Ubuntu' }],
  false,
  false,
  false,
  true
)

const revokedUsageError =
  'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Encountered invalidated oauth token for user, failing request", "type": null, "code": "token_revoked", "param": null }, "status": 401 }'
const revokedAccounts = [
  { ...BASE_ACCOUNTS[0], weekly: null, error: revokedUsageError },
  ...BASE_ACCOUNTS.slice(1, 5),
  { ...BASE_ACCOUNTS[5], error: revokedUsageError }
]

export const revokedActiveSignIn = switcherFixture(revokedAccounts, false, true)
export const revokedRemoteSignIn = switcherFixture(revokedAccounts, false, false, false, true)
