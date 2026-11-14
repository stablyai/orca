// @vitest-environment happy-dom
import { toast } from 'sonner'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectAgentLaunchSettings,
  type AgentLaunchSettings
} from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import { HostAgentLaunchSettings } from './HostAgentLaunchSettings'
import { TooltipProvider } from '../../../ui/tooltip'
import type { AgentPermissionsRenderer } from './AgentLaunchSettingsCatalog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))

const transport = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  detection: vi.fn(),
  auto: vi.fn(),
  native: vi.fn(),
  own: vi.fn(),
  choices: vi.fn()
}))
vi.mock('../../../../runtime/agent-launch-settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: transport.read,
  mutateHostAgentLaunchSettings: transport.mutate,
  hostSupportsAutoPermissions: transport.auto,
  hostSupportsNativeChatPermissions: transport.native,
  hostSupportsOwnChatPermissions: transport.own,
  hostSupportsLaunchChoices: transport.choices
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (target: unknown) => {
    return {
      detectedIds: transport.detection(target) ?? ['claude'],
      detectionFailed: false,
      isRefreshing: false,
      refresh: vi.fn()
    }
  }
}))
const host = () =>
  projectAgentLaunchSettings({
    agentDefaultArgs: { claude: '--host-marker' },
    agentDefaultEnv: { claude: { API_KEY: 'host-secret' } }
  })
const renderPermissions: AgentPermissionsRenderer = ({ onChange }) => (
  <button onClick={() => onChange('manual')}>Manual</button>
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
  vi.mocked(toast.success).mockClear()
  transport.read.mockReset().mockResolvedValue(host())
  transport.mutate.mockReset().mockResolvedValue(host())
  transport.detection.mockReset()
  transport.auto.mockReset().mockResolvedValue(true)
  transport.native.mockReset().mockResolvedValue(true)
  transport.own.mockReset().mockResolvedValue(false)
  transport.choices.mockReset().mockResolvedValue(false)
})

describe('host launch settings form', () => {
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
    expect(transport.mutate.mock.calls[1]?.[1]).toEqual({
      type: 'permissions',
      mode: 'manual',
      syncNativeChat: true
    })
  })
})
