// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ClaudeSwitcherForOwner } from './ClaudeSwitcherForOwner'

const savedAccount: ClaudeManagedAccount = {
  id: 'acct-saved',
  email: 'saved@example.com',
  managedAuthPath: '/tmp/claude-saved',
  managedAuthRuntime: 'host',
  authMethod: 'subscription-oauth',
  createdAt: 1,
  updatedAt: 2,
  lastAuthenticatedAt: 2
}

function limits(
  provider: ProviderRateLimits['provider'],
  windows: { session?: number; weekly?: number }
): ProviderRateLimits {
  return {
    provider,
    session:
      windows.session == null
        ? null
        : {
            usedPercent: windows.session,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
    weekly:
      windows.weekly == null
        ? null
        : {
            usedPercent: windows.weekly,
            windowMinutes: 10080,
            resetsAt: null,
            resetDescription: null
          },
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

const { store } = vi.hoisted(() => ({
  store: {
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    fetchSettings: vi.fn(async () => {}),
    recordFeatureInteraction: vi.fn(),
    refreshClaudeRateLimitsForTarget: vi.fn(async () => {}),
    fetchInactiveClaudeAccountUsage: vi.fn(async () => {}),
    usagePercentageDisplay: 'remaining' as const,
    settings: {
      localAccountRuntime: 'host' as const,
      activeRuntimeEnvironmentId: null as string | null,
      claudeManagedAccounts: [] as ClaudeManagedAccount[],
      activeClaudeManagedAccountId: null as string | null,
      activeClaudeManagedAccountIdsByRuntime: {
        host: null as string | null,
        wsl: {} as Record<string, string | null>
      }
    },
    rateLimits: {
      inactiveClaudeAccounts: [] as InactiveAccountUsage[],
      claudeTarget: { runtime: 'host' as const, wslDistro: null }
    },
    runtimeEnvironments: [] as { id: string; name: string }[]
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof store) => unknown) => selector(store)
}))

vi.mock('./use-provider-account-list', () => ({
  useProviderAccountList: () => ({
    accounts: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    setAccounts: () => {},
    accountsLoaded: true,
    loadAccounts: async () => {},
    mountedRef: { current: true }
  })
}))

function setLocalAccounts(activeId: string | null): void {
  // A new settings object: the account projection is cached by object identity.
  store.settings = {
    localAccountRuntime: 'host',
    activeRuntimeEnvironmentId: null,
    claudeManagedAccounts: [savedAccount],
    activeClaudeManagedAccountId: activeId,
    activeClaudeManagedAccountIdsByRuntime: { host: activeId, wsl: {} }
  }
}

afterEach(() => {
  cleanup()
  store.rateLimits.inactiveClaudeAccounts = []
  setLocalAccounts(null)
})

function menuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')]
}

function rowMatching(text: string): HTMLElement {
  const row = menuRows().find((item) => item.textContent?.includes(text))
  if (!row) {
    throw new Error(`missing account row ${text}`)
  }
  return row
}

function usageLabels(row: HTMLElement): string[] {
  return [...row.querySelectorAll('[role="img"]')].map(
    (node) => node.getAttribute('aria-label') ?? ''
  )
}

async function openSwitcher(owner: {
  target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
  wslHostDistro: null
}): Promise<void> {
  render(
    <ClaudeSwitcherForOwner
      claude={limits('claude', { session: 40 })}
      compact={false}
      iconOnly={false}
      owner={owner}
    />
  )
  const trigger = screen.getByRole('button', {
    name: 'Open Claude details and account switcher'
  })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(trigger)
  await screen.findByRole('menuitem', { name: /System default/ })
}

describe('Claude account rows show Left and Reset usage', () => {
  it('shows the active System default row from the live Claude limits', async () => {
    setLocalAccounts(null)
    store.rateLimits.inactiveClaudeAccounts = [
      {
        accountId: savedAccount.id,
        rateLimits: limits('claude', { weekly: 80 }),
        updatedAt: 1,
        isFetching: false
      }
    ]
    await openSwitcher({ target: { kind: 'local' }, wslHostDistro: null })

    const active = rowMatching('System default')
    expect(active.getAttribute('data-current')).toBe('true')
    expect(usageLabels(active).some((label) => label.includes('60% left'))).toBe(true)

    const saved = rowMatching('saved@example.com')
    expect(usageLabels(saved).some((label) => label.includes('20% left'))).toBe(true)
    expect(usageLabels(saved).some((label) => label.includes('60% left'))).toBe(false)
  })

  it('shows the active saved account from the live Claude limits, not a blank row', async () => {
    setLocalAccounts(savedAccount.id)
    await openSwitcher({ target: { kind: 'local' }, wslHostDistro: null })

    const active = rowMatching('saved@example.com')
    expect(active.getAttribute('data-current')).toBe('true')
    expect(usageLabels(active).some((label) => label.includes('60% left'))).toBe(true)

    const systemDefault = rowMatching('System default')
    expect(systemDefault.getAttribute('data-current')).toBeNull()
    expect(usageLabels(systemDefault)).toEqual([])
  })

  it('does not paint this desktop Claude limits on a paired server active row', async () => {
    setLocalAccounts(null)
    await openSwitcher({
      target: { kind: 'environment', environmentId: 'env-paired' },
      wslHostDistro: null
    })

    const active = rowMatching('System default')
    expect(active.getAttribute('data-current')).toBe('true')
    expect(usageLabels(active).some((label) => label.includes('60% left'))).toBe(false)
  })
})
