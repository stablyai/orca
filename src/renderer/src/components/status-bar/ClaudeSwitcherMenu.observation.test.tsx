// @vitest-environment happy-dom
import type * as OriginalModule1 from './ProviderDetailsMenu'
import type * as OriginalModule0 from '../../../../shared/app-environment'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { publicRuntimeEnvironment } from '@/runtime/paired-runtime-environment-test-fixture'
import { accountHost, accountTransport } from '@/runtime/provider-account-observation.test-fixture'
import { ClaudeSwitcherMenu } from './ClaudeSwitcherMenu'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({ renders: vi.fn() }))
vi.mock('../../../../shared/app-environment', async (original) => ({
  ...(await original<typeof OriginalModule0>()),
  hasAppEnvironment: () => false
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'local'
}))
vi.mock('./ProviderDetailsMenu', async (original) => {
  const actual = await original<typeof OriginalModule1>()
  return {
    ...actual,
    ProviderDetailsMenu: (props: ComponentProps<typeof actual.ProviderDetailsMenu>) => {
      mocks.renders(props.triggerContent)
      return <actual.ProviderDetailsMenu {...props} />
    }
  }
})
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

it.each([10, 100])(
  'keeps %s explicit-owner menus quiet across unrelated provider/host/store changes',
  async (count) => {
    const a = accountHost(),
      b = accountHost()
    const transport = accountTransport({ a, b })
    useAppStore.setState({
      settings: getDefaultSettings('/test'),
      runtimeEnvironments: [
        publicRuntimeEnvironment({ id: 'a', name: 'Owner A' }),
        publicRuntimeEnvironment({ id: 'b' })
      ]
    })
    render(
      <TooltipProvider>
        {Array.from({ length: count }, (_, id) => (
          <ClaudeSwitcherMenu
            key={id}
            claude={null}
            compact
            iconOnly
            triggerContent="a"
            chatAction={{
              target: { kind: 'environment', environmentId: 'a' },
              canSwitch: async () => true
            }}
          />
        ))}
        <ClaudeSwitcherMenu
          claude={null}
          compact
          iconOnly
          triggerContent="b"
          chatAction={{
            target: { kind: 'environment', environmentId: 'b' },
            canSwitch: async () => true
          }}
        />
      </TooltipProvider>
    )
    await act(async () => {})
    expect(transport.subscribe).toHaveBeenCalledTimes(2)
    mocks.renders.mockClear()
    transport.reset()
    await act(async () => a.emit())
    a.snapshot.codex.activeAccountId = 'changed'
    await act(async () => a.emit())
    await act(async () => b.emit())
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'b' },
        rateLimits: {
          ...state.rateLimits,
          inactiveClaudeAccounts: [],
          claudeTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }
        },
        runtimeEnvironments: state.runtimeEnvironments.map((host) =>
          host.id === 'b' ? { ...host, name: 'Other renamed' } : host
        )
      }))
    )
    expect(mocks.renders.mock.calls.filter(([owner]) => owner === 'a')).toHaveLength(0)
    expect(transport.subscribe).toHaveBeenCalledTimes(2)
    expect(a.claudeList).toHaveBeenCalledTimes(2)
    expect(a.codexList).toHaveBeenCalledTimes(2)
    mocks.renders.mockClear()
    await act(async () =>
      useAppStore.setState((state) => ({
        runtimeEnvironments: state.runtimeEnvironments.map((host) =>
          host.id === 'a' ? { ...host, name: 'Owner renamed' } : host
        )
      }))
    )
    expect(mocks.renders.mock.calls.filter(([owner]) => owner === 'a')).toHaveLength(count)
    expect(mocks.renders.mock.calls.some(([owner]) => owner === 'b')).toBe(false)
    mocks.renders.mockClear()
    a.snapshot.claude.systemDefaultEmail = 'system@example.com'
    a.snapshot.claude.activeAccountIdsByRuntime = { host: 'b', wsl: { Ubuntu: 'b' } }
    a.snapshot.claude.activeAccountId = 'b'
    await act(async () => a.emit())
    expect(mocks.renders.mock.calls.filter(([owner]) => owner === 'a')).toHaveLength(count)
    expect(mocks.renders.mock.calls.some(([owner]) => owner === 'b')).toBe(false)
  }
)

it.each([10, 100])('isolates %s local menus from serialized settings replies', async (count) => {
  const host = accountHost()
  accountTransport({})
  let comparisons = 0
  const list = vi.fn(async () => host.controller.getStreamSnapshot().claude)
  const set = vi.fn(async (updates) => {
    const next = structuredClone({ ...useAppStore.getState().settings!, ...updates })
    const first = next.claudeManagedAccounts[0]
    const email = first.email
    Object.defineProperty(first, 'email', {
      enumerable: true,
      get: () => {
        comparisons += 1
        return email
      }
    })
    return next
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...window.api,
      claudeAccounts: { ...window.api.claudeAccounts, list },
      codexAccounts: { ...window.api.codexAccounts, list: async () => host.snapshot.codex },
      settings: { ...window.api.settings, set }
    }
  })
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/test'),
      claudeManagedAccounts: host.snapshot.claude.accounts.map((account) => ({
        ...account,
        managedAuthPath: '/unused'
      })),
      activeClaudeManagedAccountId: 'a',
      activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
    }
  })
  render(
    <TooltipProvider>
      {Array.from({ length: count }, (_, id) => (
        <ClaudeSwitcherMenu
          key={id}
          claude={null}
          compact
          iconOnly
          triggerContent="local"
          chatAction={{ target: { kind: 'local' }, canSwitch: async () => true }}
        />
      ))}
    </TooltipProvider>
  )
  await act(async () => {})
  mocks.renders.mockClear()
  await act(async () => useAppStore.getState().updateSettings({ terminalFontSize: 17 }))
  expect(set).toHaveBeenCalledTimes(1)
  expect(mocks.renders).not.toHaveBeenCalled()
  expect(comparisons).toBeGreaterThan(0)
  expect(comparisons).toBeLessThanOrEqual(4)
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () =>
    useAppStore.getState().updateSettings({
      activeClaudeManagedAccountId: 'b',
      activeClaudeManagedAccountIdsByRuntime: { host: 'b', wsl: {} }
    })
  )
  expect(mocks.renders).toHaveBeenCalledTimes(2 * count)
  expect(list).toHaveBeenCalledTimes(2)
})
