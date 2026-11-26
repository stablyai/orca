// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { ClaudeSwitcherForOwner } from './ClaudeSwitcherForOwner'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'
import { useCodexSwitcherController } from './use-codex-switcher-controller'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { OwnerUsageRateLimits } from '../usage/use-owner-usage-rate-limits'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/hosts/capabilities/windows-terminal-capabilities', () => ({
  getWindowsTerminalCapabilityOwnerKey: () => 'visible',
  useWindowsTerminalCapabilities: () => ({
    wslAvailable: true,
    wslDistros: ['Ubuntu'],
    hostPlatform: 'win32',
    isLoading: false
  })
}))
const owner = {
  target: { kind: 'environment' as const, environmentId: 'visible' },
  wslHostDistro: null
}
function usage(provider: ProviderRateLimits['provider'], percent: number): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent: percent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    status: 'ok',
    error: null,
    updatedAt: 1
  }
}
const openSettingsTarget = vi.fn()
const refreshLocal = vi.fn()
function snapshot(): ProviderAccountsSnapshot {
  const base = { email: 'inactive@example.com', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
  return {
    claude: {
      accounts: [
        { ...base, id: 'same-id', authMethod: 'subscription-oauth' },
        {
          ...base,
          id: 'wsl',
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          authMethod: 'subscription-oauth'
        }
      ],
      activeAccountId: null
    },
    codex: {
      accounts: [
        { ...base, id: 'same-id' },
        { ...base, id: 'wsl', managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }
      ],
      activeAccountId: null
    },
    rateLimits: createEmptyRateLimitState({
      inactiveClaudeAccounts: [
        { accountId: 'same-id', rateLimits: usage('claude', 17), updatedAt: 1, isFetching: false }
      ],
      inactiveCodexAccounts: [
        { accountId: 'same-id', rateLimits: usage('codex', 17), updatedAt: 1, isFetching: false }
      ]
    })
  }
}
function ownerUsageFor(owner: AccountOwner): OwnerUsageRateLimits {
  const remote = owner.target.kind === 'environment' ? owner.target.environmentId : null
  const accounts = remote ? snapshot() : null
  return {
    owner,
    rateLimits: accounts?.rateLimits ?? useAppStore.getState().rateLimits,
    accounts,
    remoteOwner: remote ? { environmentId: remote, label: 'Visible host' } : null,
    refreshRemote: null
  }
}
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  openSettingsTarget.mockReset()
  refreshLocal.mockReset()
  mocks.rpc
    .mockReset()
    .mockImplementation(async (_target, method) => (method === 'accounts.list' ? snapshot() : {}))
  Object.assign(window, {
    api: {
      claudeAccounts: { list: async () => snapshot().claude },
      codexAccounts: { list: async () => snapshot().codex },
      runtimeEnvironments: {
        subscribe: async (
          _args: unknown,
          handlers: { onResponse?: (response: unknown) => void }
        ) => {
          queueMicrotask(() =>
            handlers.onResponse?.({
              id: 'fixture',
              _meta: { runtimeId: 'fixture' },
              ok: true,
              result: { type: 'snapshot', snapshot: snapshot() }
            })
          )
          return { sendBinary: () => {}, unsubscribe: () => {} }
        }
      }
    }
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/fixture'), activeRuntimeEnvironmentId: 'stale-default' },
    openSettingsTarget,
    openSettingsPage: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    refreshClaudeRateLimitsForTarget: refreshLocal,
    refreshCodexRateLimitsForTarget: refreshLocal,
    usagePercentageDisplay: 'used',
    rateLimits: createEmptyRateLimitState({
      inactiveClaudeAccounts: [
        { accountId: 'same-id', rateLimits: usage('claude', 99), updatedAt: 1, isFetching: false }
      ],
      inactiveCodexAccounts: [
        { accountId: 'same-id', rateLimits: usage('codex', 99), updatedAt: 1, isFetching: false }
      ]
    })
  })
})
afterEach(cleanup)

it.each(['claude', 'codex'] as const)(
  'opens %s Manage Accounts for the visible host and keeps colliding desktop quota out',
  async (provider) => {
    render(
      <TooltipProvider>
        {provider === 'claude' ? (
          <ClaudeSwitcherForOwner
            claude={usage('claude', 11)}
            iconOnly={false}
            owner={owner}
            ownerUsage={ownerUsageFor(owner)}
          />
        ) : (
          <CodexSwitcherMenu codex={usage('codex', 11)} ownerUsage={ownerUsageFor(owner)} />
        )}
      </TooltipProvider>
    )
    fireEvent.pointerDown(
      screen.getByRole('button', {
        name: provider === 'claude' ? /Open Claude details/ : /Open Codex details/
      }),
      { button: 0, ctrlKey: false }
    )
    const row = await screen.findByRole('menuitem', { name: /inactive@example.com/ })
    expect(await within(row).findByRole('img', { name: /17/ })).toBeDefined()
    expect(within(row).queryByRole('img', { name: /99/ })).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage Accounts/ }))
    expect(openSettingsTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionId: `accounts-${provider}`,
        hostScope: { kind: 'environment', environmentId: 'visible' }
      })
    )
  }
)
it('cannot dispatch a paired runtime change through desktop quota IPC', async () => {
  const { result } = renderHook(() =>
    useCodexSwitcherController(usage('codex', 11), ownerUsageFor(owner), owner)
  )
  await act(async () => {
    await Promise.resolve()
  })
  const wsl = result.current.switchGroups.find((group) => group.runtimeTarget.runtime === 'wsl')!
  await act(async () => {
    await result.current.handleSelectRuntime(wsl)
  })
  expect(refreshLocal).not.toHaveBeenCalled()
})

it.each([
  { runtime: 'host' as const, wslDistro: null },
  { runtime: 'wsl' as const, wslDistro: 'Debian' }
])(
  'cannot spend another target credit while showing WSL Ubuntu over $runtime/$wslDistro',
  async (target) => {
    let credits = 1
    useAppStore.setState({
      rateLimits: createEmptyRateLimitState({ codexTarget: target }),
      consumeCodexRateLimitResetCredit: async () => {
        credits -= 1
      }
    })
    const offer = {
      ...usage('codex', 90),
      rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null }
    }
    const wslOwner = { target: { kind: 'local' as const }, wslHostDistro: 'Ubuntu' }
    const { result } = renderHook(() =>
      useCodexSwitcherController(offer, ownerUsageFor(wslOwner), wslOwner)
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.canRedeemReset).toBe(false)
    await act(async () => {
      await result.current.handleConfirmReset()
    })
    expect(credits).toBe(1)
  }
)
it('rejects a stale desktop reset confirmation after the global target changes to WSL', async () => {
  let credits = 1
  useAppStore.setState({
    consumeCodexRateLimitResetCredit: async () => {
      credits -= 1
    }
  })
  const offer = {
    ...usage('codex', 90),
    rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null }
  }
  const desktopOwner = { target: { kind: 'local' as const }, wslHostDistro: null }
  const { result } = renderHook(() =>
    useCodexSwitcherController(offer, ownerUsageFor(desktopOwner), desktopOwner)
  )
  await act(async () => {
    await Promise.resolve()
  })
  const oldConfirm = result.current.handleConfirmReset
  act(() =>
    useAppStore.setState({
      rateLimits: createEmptyRateLimitState({
        codexTarget: { runtime: 'wsl', wslDistro: 'Debian' }
      })
    })
  )
  await act(async () => {
    await oldConfirm()
  })
  expect(credits).toBe(1)
})
