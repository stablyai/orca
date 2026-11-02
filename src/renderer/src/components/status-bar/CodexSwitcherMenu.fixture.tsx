import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CodexManagedAccount } from '../../../../shared/managed-account-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../shared/rate-limit-types'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'
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
  /** Weekly used percent; null when the account needs a sign-in. */
  weekly: number | null
  resetsInDays: number
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

function usageFor(account: SampleAccount): ProviderRateLimits {
  return {
    provider: 'codex',
    session:
      account.weekly === null
        ? null
        : {
            usedPercent: 32,
            windowMinutes: 300,
            resetsAt: NOW + 80 * 60_000 + 5_000,
            resetDescription: null
          },
    weekly: account.weekly === null ? null : weeklyWindow(account.weekly, account.resetsInDays),
    updatedAt: NOW - 60_000,
    error: account.weekly === null ? 'Not signed in' : null,
    status: account.weekly === null ? 'error' : 'ok'
  }
}

function managed(account: SampleAccount): CodexManagedAccount {
  return {
    id: account.id,
    email: account.email,
    managedHomePath: `/home/me/.orca/codex/${account.id}`,
    providerAccountId: `provider-${account.id}`,
    workspaceLabel: account.workspace,
    workspaceAccountId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastAuthenticatedAt: NOW
  }
}

function switcherFixture(accounts: SampleAccount[], asSubmenu = false) {
  const [active, ...inactive] = accounts
  const codex: ProviderRateLimits = {
    ...usageFor(active),
    rateLimitResetCredits: { availableCount: 1, nextExpiresAt: NOW + 29 * DAY }
  }
  const inactiveCodexAccounts: InactiveAccountUsage[] = inactive.map((account) => ({
    accountId: account.id,
    rateLimits: usageFor(account),
    updatedAt: NOW - 60_000,
    isFetching: false
  }))
  return defineFixture({
    width: 520,
    store: {
      settings: {
        ...getDefaultSettings('/home/me'),
        codexManagedAccounts: accounts.map(managed),
        activeCodexManagedAccountId: active.id,
        activeCodexManagedAccountIdsByRuntime: { host: active.id, wsl: {} }
      },
      rateLimits: createEmptyRateLimitState({ codex, inactiveCodexAccounts }),
      fetchInactiveCodexAccountUsage: async () => {}
    },
    setup: () => {
      // Settings already carry the roster; the web bridge has no local account IPC to answer.
      window.api.codexAccounts.list = async () => ({ accounts: [], activeAccountId: null })
      window.api.claudeAccounts.list = async () => ({ accounts: [], activeAccountId: null })
    },
    render: () => (
      <div className="flex h-[760px] items-end bg-background p-3">
        {asSubmenu ? (
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
            <DropdownMenuContent>
              <CodexSwitcherMenu
                codex={codex}
                compact={false}
                iconOnly={false}
                asSubmenu
                triggerContent="Codex"
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <CodexSwitcherMenu codex={codex} compact={false} iconOnly={false} />
        )}
      </div>
    ),
    interact: (frame) => {
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

export const longList = switcherFixture([...BASE_ACCOUNTS, ...EXTRA_ACCOUNTS])

export const submenu = switcherFixture([...BASE_ACCOUNTS, ...EXTRA_ACCOUNTS], true)
