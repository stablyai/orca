// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ChatPermissionSetting } from './ChatPermissionSetting'
import { TooltipProvider } from '../ui/tooltip'

const mocks = vi.hoisted(() => ({
  web: false,
  capability: 'unsupported',
  call: vi.fn(),
  supports: vi.fn(async () => true),
  contacts: new Set<() => void>(),
  environments: [{ id: 'host', createdAt: 1, pairingRevision: 7, runtimeId: 'runtime-1' }]
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionOwnPermissionState: () => mocks.capability
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_id: string, listener: () => void) => {
    mocks.contacts.add(listener)
    return () => mocks.contacts.delete(listener)
  }
}))
vi.mock('../../store', () => ({
  useAppStore: (
    selector: (value: {
      settingsSearchQuery: string
      runtimeEnvironments: typeof mocks.environments
    }) => unknown
  ) => selector({ settingsSearchQuery: '', runtimeEnvironments: mocks.environments })
}))
import { mutateHostAgentLaunchSettings } from './agent-launch-settings-transport'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
beforeEach(() => {
  mocks.web = false
  mocks.capability = 'unsupported'
  mocks.call.mockReset()
  mocks.environments = [{ id: 'host', createdAt: 1, pairingRevision: 7, runtimeId: 'runtime-1' }]
})
afterEach(cleanup)

// A web client unpaired from its host holds no value, so it shows no control.
it.each([undefined, 'ask', 'full-access'] as const)(
  'offers the legacy new-chat default only for a host value %s',
  (mode) => {
    const { container } = render(
      <TooltipProvider>
        <ChatPermissionSetting
          settings={{ ...getDefaultSettings('/tmp'), nativeChatPermissionMode: mode }}
          updateSettings={vi.fn()}
          forceVisible
        />
      </TooltipProvider>
    )
    if (mode === undefined) {
      expect(container.querySelector('#chat-permissions')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    } else {
      expect(
        screen.getByRole('button', {
          name: `Permissions ${mode === 'ask' ? 'Ask for approval' : 'Full access'}`
        })
      ).toBeTruthy()
    }
  }
)

it('shows the paired host permission and follows mutations, reconnects and re-pair ownership', async () => {
  mocks.web = true
  mocks.capability = 'supported'
  mocks.call.mockResolvedValue({
    settings: projectAgentLaunchSettings({ agentPermissionDefault: 'own' })
  })
  const element = () => (
    <TooltipProvider>
      <ChatPermissionSetting
        settings={{ ...getDefaultSettings('/tmp'), agentPermissionDefault: 'full-access' }}
        updateSettings={vi.fn()}
        forceVisible
      />
    </TooltipProvider>
  )
  const view = render(element())
  const claudeRow = () => screen.getByText('Claude').parentElement?.parentElement
  const expectClaude = async (label: string) => {
    await waitFor(() => {
      const row = claudeRow()
      if (!row) {
        throw new Error('missing Claude row')
      }
      expect(within(row).getByText(label)).toBeTruthy()
    })
  }
  await expectClaude('Own settings')
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'host' },
    'settings.getAgentLaunch',
    undefined,
    expect.objectContaining({
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-1'
    })
  )
  mocks.call.mockResolvedValue({
    settings: projectAgentLaunchSettings({ agentPermissionDefault: 'ask' })
  })
  await act(async () => {
    await mutateHostAgentLaunchSettings(
      { environmentId: 'host', pairingRevision: 7 },
      { type: 'permission', choice: 'ask' }
    )
  })
  await expectClaude('Ask for approval')
  mocks.call.mockResolvedValue({
    settings: projectAgentLaunchSettings({ agentPermissionDefault: 'accept-edits' })
  })
  await act(async () => {
    mocks.contacts.forEach((listener) => listener())
  })
  await expectClaude('Accept edits')
  let resolveOld: (value: unknown) => void = () => {}
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  act(() => {
    mocks.contacts.forEach((listener) => listener())
  })
  mocks.environments = [{ id: 'host', createdAt: 1, pairingRevision: 8, runtimeId: 'runtime-2' }]
  mocks.call.mockResolvedValue({
    settings: projectAgentLaunchSettings({ agentPermissionDefault: 'auto' })
  })
  view.rerender(element())
  await expectClaude('Approve for me')
  await act(async () => {
    resolveOld({ settings: projectAgentLaunchSettings({ agentPermissionDefault: 'full-access' }) })
  })
  await expectClaude('Approve for me')
})

it('keeps the Agents link disabled until host support is known', () => {
  mocks.capability = 'unknown'
  const element = (
    <TooltipProvider>
      <ChatPermissionSetting
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        forceVisible
      />
    </TooltipProvider>
  )
  const view = render(element)
  expect(screen.getByRole('button', { name: 'Settings → Agents' }).hasAttribute('disabled')).toBe(
    true
  )
  mocks.capability = 'supported'
  view.rerender(
    <TooltipProvider>
      <ChatPermissionSetting
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        forceVisible
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Settings → Agents' }).hasAttribute('disabled')).toBe(
    false
  )
})
