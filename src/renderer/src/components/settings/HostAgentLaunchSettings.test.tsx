// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectAgentLaunchSettings,
  type AgentLaunchSettings
} from '../../../../shared/agent-launch-settings'
import { HostAgentLaunchSettings } from './HostAgentLaunchSettings'
import { TooltipProvider } from '../ui/tooltip'
import type { AgentPermissionsRenderer } from './AgentLaunchSettingsCatalog'
import { AgentsPane } from './AgentsPane'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

const transport = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn(), detection: vi.fn() }))
vi.mock('./agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: transport.read,
  mutateHostAgentLaunchSettings: transport.mutate
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (target: unknown) => {
    transport.detection(target)
    return {
      detectedIds: ['claude'],
      detectionFailed: false,
      isRefreshing: false,
      refresh: vi.fn()
    }
  }
}))
vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({
    hostOptions: [
      { id: 'local', label: 'Local', kind: 'local', health: 'local', presence: 'local' },
      {
        id: 'runtime:ssh-host',
        label: 'SSH host',
        kind: 'runtime',
        health: 'available',
        presence: 'configured'
      }
    ]
  })
}))

const host = () =>
  projectAgentLaunchSettings({
    agentDefaultArgs: { claude: '--host-marker' },
    agentDefaultEnv: { claude: { API_KEY: 'host-secret' } }
  })
const renderPermissions: AgentPermissionsRenderer = (_mode, change) => (
  <button onClick={() => change('manual')}>Manual</button>
)
const pane = (revision: number) => (
  <TooltipProvider>
    <HostAgentLaunchSettings
      key={revision}
      environmentId="ssh-host"
      pairingRevision={revision}
      hostName="SSH host"
      renderPermissions={renderPermissions}
    />
  </TooltipProvider>
)

afterEach(cleanup)
beforeEach(() => {
  transport.read.mockReset().mockResolvedValue(host())
  transport.mutate.mockReset().mockResolvedValue(host())
  transport.detection.mockClear()
})

describe('host launch settings form', () => {
  it('routes the pane to the workspace host and saves arguments without editing desktop defaults', async () => {
    const desktop = createGlobalSettingsFixture({
      activeRuntimeEnvironmentId: null,
      agentDefaultArgs: { claude: '--desktop-marker' },
      agentDefaultEnv: { claude: { DESKTOP_KEY: 'desktop-secret' } }
    })
    useAppStore.setState({
      settings: desktop,
      activeWorktreeId: 'folder:remote',
      activeWorkspaceExecutionHostId: 'runtime:ssh-host',
      restoredRuntimeHostIdByWorkspaceSessionKey: { 'folder:remote': 'runtime:ssh-host' },
      runtimeEnvironments: [
        {
          id: 'ssh-host',
          name: 'SSH host',
          createdAt: 1,
          updatedAt: 1,
          pairingRevision: 17,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'remote'
        }
      ]
    })
    const updateDesktop = vi.fn()
    render(
      <TooltipProvider>
        <AgentsPane settings={desktop} updateSettings={updateDesktop} />
      </TooltipProvider>
    )
    const args = await screen.findByDisplayValue('--host-marker')
    expect(
      screen.getByText(
        'Choose whether Orca launches agents with fewer permission prompts or with manual checks.'
      )
    ).toBeTruthy()
    expect(screen.queryByDisplayValue('--desktop-marker')).toBeNull()
    fireEvent.change(args, { target: { value: '--r10-marker' } })
    fireEvent.blur(args)
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'arguments', agent: 'claude', value: '--r10-marker' },
        expect.any(AbortSignal)
      )
    )
    expect(updateDesktop).not.toHaveBeenCalled()
    expect(desktop.agentDefaultEnv?.claude?.DESKTOP_KEY).toBe('desktop-secret')
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }))
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'permissions', mode: 'manual' },
        expect.any(AbortSignal)
      )
    )
    expect(updateDesktop).not.toHaveBeenCalled()
  })

  it('renders host arguments and masked values, then writes the selected host', async () => {
    const { container } = render(pane(17))
    await screen.findByDisplayValue('--host-marker')
    expect(transport.detection).toHaveBeenCalledWith({ kind: 'runtime', environmentId: 'ssh-host' })
    expect(screen.getByRole('textbox', { name: 'Environment variable name' })).toBeTruthy()
    const secret = container.querySelector<HTMLInputElement>('[aria-label="Value for API_KEY"]')
    expect(secret?.type).toBe('password')
    expect(secret?.value).toBe('')
    expect(container.innerHTML).not.toContain('host-secret')
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'permissions', mode: 'manual' },
        expect.any(AbortSignal)
      )
    )
  })

  it('retains a typed env replacement after failure and never submits it on blur', async () => {
    const { container } = render(pane(17))
    await screen.findByDisplayValue('--host-marker')
    const secret = container.querySelector<HTMLInputElement>('[aria-label="Value for API_KEY"]')
    if (!secret) {
      throw new Error('missing saved environment input')
    }
    fireEvent.change(secret, { target: { value: 'typed-secret' } })
    fireEvent.blur(secret)
    expect(transport.mutate).not.toHaveBeenCalled()
    transport.mutate.mockRejectedValue(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(secret.value).toBe('typed-secret')
    expect(screen.getByRole('alert').textContent).not.toContain('typed-secret')
    transport.mutate.mockResolvedValue(host())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(secret.value).toBe(''))
  })

  it('serializes successive field saves without dropping a click while the first is pending', async () => {
    let finishArguments!: (settings: AgentLaunchSettings) => void
    transport.mutate.mockImplementationOnce(
      () =>
        new Promise<AgentLaunchSettings>((resolve) => {
          finishArguments = resolve
        })
    )
    render(pane(17))
    const args = await screen.findByDisplayValue('--host-marker')
    fireEvent.change(args, { target: { value: '--next-marker' } })
    fireEvent.blur(args)
    await waitFor(() => expect(transport.mutate).toHaveBeenCalledTimes(1))
    expect(args).toHaveProperty('readOnly', true)
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    expect(transport.mutate).toHaveBeenCalledTimes(1)
    finishArguments(projectAgentLaunchSettings({ agentDefaultArgs: { claude: '--next-marker' } }))
    await waitFor(() => expect(transport.mutate).toHaveBeenCalledTimes(2))
    expect(transport.mutate.mock.calls[1]?.[1]).toEqual({ type: 'permissions', mode: 'manual' })
  })

  it('does not display launch controls or local defaults for an old server', async () => {
    transport.read.mockResolvedValue(null)
    render(pane(17))
    await screen.findByText('Update this server to edit its agent launch settings.')
    expect(screen.queryByText('Default Agent')).toBeNull()
    expect(transport.detection).not.toHaveBeenCalled()
    expect(transport.mutate).not.toHaveBeenCalled()
  })

  it('discards a late read from the retired pairing', async () => {
    let resolveOld!: (settings: AgentLaunchSettings) => void
    transport.read.mockImplementationOnce(
      () =>
        new Promise<AgentLaunchSettings>((resolve) => {
          resolveOld = resolve
        })
    )
    const { rerender } = render(pane(17))
    const oldSignal: AbortSignal = transport.read.mock.calls[0]?.[1]
    rerender(pane(18))
    await screen.findByDisplayValue('--host-marker')
    expect(oldSignal.aborted).toBe(true)
    resolveOld(projectAgentLaunchSettings({ agentDefaultArgs: { claude: '--retired-host' } }))
    await waitFor(() => expect(screen.queryByDisplayValue('--retired-host')).toBeNull())
    expect(screen.getByDisplayValue('--host-marker')).toBeTruthy()
  })

  it('drops unsaved environment values when the peer is re-paired', async () => {
    const { container, rerender } = render(pane(17))
    await screen.findByDisplayValue('--host-marker')
    const secret = container.querySelector<HTMLInputElement>('[aria-label="Value for API_KEY"]')
    if (!secret) {
      throw new Error('missing saved environment input')
    }
    fireEvent.change(secret, { target: { value: 'unsaved-secret' } })
    rerender(pane(18))
    await screen.findByDisplayValue('--host-marker')
    const nextSecret = container.querySelector<HTMLInputElement>('[aria-label="Value for API_KEY"]')
    expect(nextSecret?.value).toBe('')
    expect(container.innerHTML).not.toContain('unsaved-secret')
    expect(transport.mutate).not.toHaveBeenCalled()
  })

  it('can read again after Strict Mode cleans up the first mount', async () => {
    render(<StrictMode>{pane(17)}</StrictMode>)
    await screen.findByDisplayValue('--host-marker')
    expect(transport.read.mock.calls.at(-1)?.[1].aborted).toBe(false)
  })
})
