// @vitest-environment happy-dom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deferred,
  fixture
} from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import { RuntimeClientSettingsController } from '../../src/main/runtime/runtime-client-settings'
import { HostAgentLaunchSettings } from '../../src/renderer/src/components/settings/HostAgentLaunchSettings'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { getAgentCatalog } from '../../src/renderer/src/lib/agent-catalog'

const transport = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }))
const hooks = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }))
vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../src/main/ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../src/main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: hooks.apply
}))
vi.mock('../../src/renderer/src/components/settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: transport.read,
  mutateHostAgentLaunchSettings: transport.mutate
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

afterEach(cleanup)
describe('host form and committed-settings contract', () => {
  it('commits a following form edit while availability hook bookkeeping is still pending', async () => {
    const { store, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    await controller.mutateAgentLaunch({
      type: 'arguments',
      agent: 'claude',
      value: '--host-marker'
    })
    transport.read.mockResolvedValue(controller.getAgentLaunch())
    transport.mutate.mockImplementation((_owner, mutation) =>
      controller.mutateAgentLaunch(mutation)
    )
    const started = deferred<void>()
    const finish = deferred<void>()
    hooks.apply.mockImplementationOnce(async () => {
      started.resolve()
      await finish.promise
    })
    render(
      createElement(
        TooltipProvider,
        {},
        createElement(HostAgentLaunchSettings, {
          environmentId: 'ssh-host',
          pairingRevision: 17,
          hostName: 'SSH host',
          renderPermissions: () => createElement('span')
        })
      )
    )
    await screen.findByDisplayValue('--host-marker')
    const label = getAgentCatalog().find((agent) => agent.id === 'claude')?.label
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: `${label} availability` })).getByRole('radio', {
        name: 'Disabled'
      })
    )
    try {
      await started.promise
      expect(readState().settings.disabledTuiAgents).toContain('claude')
      const args = screen.getByDisplayValue('--host-marker')
      fireEvent.change(args, { target: { value: '--unblocked-followup' } })
      fireEvent.blur(args)
      await waitFor(() =>
        expect(readState().settings.agentDefaultArgs.claude).toBe('--unblocked-followup')
      )
      await waitFor(() =>
        expect(screen.getByDisplayValue('--unblocked-followup')).toHaveProperty('readOnly', false)
      )
      expect(transport.mutate).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      finish.resolve()
      await waitFor(() =>
        expect(readState().settings.agentDefaultArgs.claude).toBe('--unblocked-followup')
      )
    }
  })
})
