// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { toast } from 'sonner'
import { permissionNotice } from './__fixtures__/permission-notice-test-fixture'
import userEvent from '@testing-library/user-event'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import { HostAgentLaunchSettings } from './HostAgentLaunchSettings'
import * as permissionControls from './AgentPermissionChoiceControls'
import { SettingsSegmentedControl } from './SettingsFormControls'
import type { AgentPermissionChoice } from '../../../../shared/tui-agent-permission-choice'
import { TooltipProvider } from '../ui/tooltip'
import type { AgentPermissionsRenderer } from './AgentLaunchSettingsCatalog'
import { AgentPermissionsSetting, AgentsPane } from './AgentsPane'
import { useAppStore } from '@/store'
import { applyAgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))

const transport = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  detection: vi.fn(),
  auto: vi.fn(),
  native: vi.fn(),
  own: vi.fn()
}))
vi.mock('./agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: transport.read,
  mutateHostAgentLaunchSettings: transport.mutate,
  hostSupportsAutoPermissions: transport.auto,
  hostSupportsNativeChatPermissions: transport.native,
  hostSupportsOwnChatPermissions: transport.own
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
async function selectLegacyPermission(label: string, name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: label }))
  await user.click(await screen.findByRole('menuitemradio', { name: new RegExp(name) }))
}

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
})

describe('host launch settings form', () => {
  it.each([false, true])(
    'describes Own for the selected host capability: %s',
    async (supported) => {
      transport.own.mockResolvedValue(supported)
      transport.read.mockResolvedValue(
        projectAgentLaunchSettings({ agentPermissionDefault: 'own' })
      )
      render(pane(17))
      await screen.findByText("Each agent's own settings")
      await userEvent.setup().click(screen.getByRole('button', { name: 'Permissions' }))
      await screen.findByText(
        supported
          ? 'Terminals and chats follow the agent’s own permission settings.'
          : 'Orca adds no permission flag in terminals; chats use Settings → Chat.'
      )
      expect(transport.own).toHaveBeenCalledWith({ environmentId: 'ssh-host', pairingRevision: 17 })
    }
  )

  it('shows resolved launch defaults in a collapsed legacy host row', async () => {
    transport.read.mockResolvedValue(projectAgentLaunchSettings({ agentDefaultArgs: {} }))
    render(pane(17))
    const row = (await screen.findByRole('radiogroup', { name: 'Claude availability' })).closest(
      '.py-3'
    )
    if (!(row instanceof HTMLElement)) {
      throw new Error('missing Claude settings row')
    }
    expect(within(row).getByText('--dangerously-skip-permissions')).toBeTruthy()
    expect(transport.mutate).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'offers automatic permissions only when supported: %s',
    async (supported) => {
      transport.auto.mockResolvedValue(supported)
      render(
        <TooltipProvider>
          <HostAgentLaunchSettings
            environmentId="ssh-host"
            pairingRevision={17}
            hostName="SSH host"
            renderPermissions={(props) => <AgentPermissionsSetting {...props} />}
          />
        </TooltipProvider>
      )
      await screen.findByDisplayValue('--host-marker')
      await userEvent.click(screen.getByRole('button', { name: 'Agent Permissions' }))
      const auto = await screen.findByRole('menuitemradio', { name: /Approve for me/ })
      expect(auto.getAttribute('aria-disabled') === 'true').toBe(!supported)
      fireEvent.click(auto)
      if (supported) {
        await waitFor(() =>
          expect(transport.mutate).toHaveBeenCalledWith(
            { environmentId: 'ssh-host', pairingRevision: 17 },
            { type: 'permissions', mode: 'auto', syncNativeChat: true },
            expect.any(AbortSignal)
          )
        )
      } else {
        expect(transport.mutate).not.toHaveBeenCalled()
      }
    }
  )

  it.each([false, true])(
    'sends native synchronization only when the host supports it: %s',
    async (nativeSupported) => {
      transport.native.mockResolvedValue(nativeSupported)
      render(
        <TooltipProvider>
          <HostAgentLaunchSettings
            environmentId="ssh-host"
            pairingRevision={17}
            hostName="SSH host"
            renderPermissions={(props) => <AgentPermissionsSetting {...props} />}
          />
        </TooltipProvider>
      )
      await screen.findByDisplayValue('--host-marker')
      await selectLegacyPermission('Agent Permissions', "Each agent's own settings")
      await waitFor(() =>
        expect(transport.mutate).toHaveBeenCalledWith(
          { environmentId: 'ssh-host', pairingRevision: 17 },
          {
            type: 'permissions',
            mode: 'manual',
            ...(nativeSupported ? { syncNativeChat: true } : {})
          },
          expect.any(AbortSignal)
        )
      )
    }
  )

  const fullPane = () => (
    <TooltipProvider>
      <HostAgentLaunchSettings
        environmentId="ssh-host"
        pairingRevision={17}
        hostName="SSH host"
        renderPermissions={(props) => <AgentPermissionsSetting {...props} />}
      />
    </TooltipProvider>
  )

  it.each([false, true])(
    'changes only agents without Auto from the legacy secondary picker (mixed=%s)',
    async (mixed) => {
      const source = applyAgentPermissionMode({
        mode: 'auto',
        ...applyAgentPermissionMode({ mode: 'yolo' })
      })
      const automatic = projectAgentLaunchSettings({
        ...source,
        agentDefaultArgs: { ...source.agentDefaultArgs, ...(mixed ? { gemini: '' } : {}) }
      })
      transport.read.mockResolvedValue(automatic)
      transport.mutate.mockResolvedValue(automatic)
      render(fullPane())
      const trigger = await screen.findByRole('button', { name: 'Permissions for other agents' })
      expect(trigger.textContent).toContain(mixed ? 'Mixed' : 'Full access')
      fireEvent.focus(screen.getByRole('button', { name: 'Supported agents' }))
      expect((await screen.findByRole('tooltip')).textContent).toContain(
        'Claude, Claude Agent Teams, and Codex'
      )
      await userEvent.click(screen.getByRole('button', { name: 'Permissions for other agents' }))
      expect(
        screen.getByRole('menuitemradio', { name: /Full access/ }).getAttribute('aria-checked')
      ).toBe(String(!mixed))
      expect(screen.queryByRole('menuitemradio', { name: /Approve for me/ })).toBeNull()
      await userEvent.click(
        screen.getByRole('menuitemradio', { name: /Each agent's own settings/ })
      )
      await waitFor(() =>
        expect(transport.mutate).toHaveBeenCalledWith(
          { environmentId: 'ssh-host', pairingRevision: 17 },
          { type: 'permissions', mode: 'manual', exceptAuto: true, syncNativeChat: true },
          expect.any(AbortSignal)
        )
      )
    }
  )

  it.each(['own', 'full-access'] as const)(
    'preserves the former secondary path inputs and rejection outcomes for %s',
    async (choice) => {
      const saved = {
        agentPermissionDefault: 'auto',
        agentPermissionOverrides: { claude: 'ask', gemini: 'own', goose: 'full-access' }
      } as const
      const initial = projectAgentLaunchSettings(saved)
      const mutation = { type: 'permission', choice, withoutAuto: true } as const
      const acknowledged = projectAgentLaunchSettings({
        ...saved,
        ...agentLaunchSettingsMutationUpdates(saved, mutation, 'darwin')
      })
      expect(acknowledged.agentPermission?.default).toBe('auto')
      expect(acknowledged.agentPermission?.overrides).toMatchObject({
        claude: 'ask',
        gemini: choice,
        goose: choice
      })
      const requests: AgentLaunchSettingsMutation[][] = []
      for (const presentation of ['segments', 'menu']) {
        // Former secondary view, exercising the same production caller and failed-save path.
        const previous =
          presentation === 'segments'
            ? vi
                .spyOn(permissionControls, 'AllAgentsPermissionSetting')
                .mockImplementation((props) => (
                  <SettingsSegmentedControl<AgentPermissionChoice | 'mixed'>
                    value={props.withoutAutoChoice ?? 'mixed'}
                    onChange={(next) => {
                      if (next !== 'mixed') {
                        props.onChangeWithoutAuto(next)
                      }
                    }}
                    ariaLabel="Permissions for other agents"
                    size="sm"
                    options={[
                      { value: 'own', label: 'Own settings' },
                      { value: 'full-access', label: 'Full access' }
                    ]}
                  />
                ))
            : undefined
        transport.read.mockResolvedValue(initial)
        transport.mutate
          .mockReset()
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValueOnce(acknowledged)
        const view = render(fullPane())
        try {
          const user = userEvent.setup()
          const trigger =
            presentation === 'menu'
              ? await screen.findByRole('button', { name: 'Permissions for other agents' })
              : null
          if (trigger) {
            expect(trigger.textContent).toContain('Mixed')
          } else {
            await screen.findByRole('radiogroup', { name: 'Permissions for other agents' })
          }
          const select = async () => {
            if (trigger) {
              await user.click(trigger)
            }
            const role = trigger ? 'menuitemradio' : 'radio'
            const group = screen.getByRole(trigger ? 'group' : 'radiogroup', {
              name: 'Permissions for other agents'
            })
            const items = within(group).getAllByRole(role)
            expect(items).toHaveLength(2)
            expect(items.every((item) => item.getAttribute('aria-checked') === 'false')).toBe(true)
            await user.click(
              within(group).getByRole(role, {
                name:
                  choice === 'own' ? /(?:Each agent's own settings|Own settings)/ : /Full access/
              })
            )
          }
          await select()
          const alert = await screen.findByRole('alert')
          expect(alert.textContent).toBe(
            'Couldn’t save agent settings. Check the host connection and try again.'
          )
          expect(transport.mutate).toHaveBeenCalledExactlyOnceWith(
            { environmentId: 'ssh-host', pairingRevision: 17 },
            mutation,
            expect.any(AbortSignal)
          )
          if (trigger) {
            expect(trigger.textContent).toContain('Mixed')
          }
          await select()
          await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
          requests.push(transport.mutate.mock.calls.map((call) => call[1]))
          const selected = trigger
            ? trigger.textContent
            : screen
                .getByRole('radio', { name: choice === 'own' ? 'Own settings' : 'Full access' })
                .getAttribute('aria-checked')
          if (trigger) {
            expect(selected).toContain(
              choice === 'own' ? "Each agent's own settings" : 'Full access'
            )
          } else {
            expect(selected).toBe('true')
          }
        } finally {
          view.unmount()
          previous?.mockRestore()
        }
      }
      expect(requests).toEqual([
        [mutation, mutation],
        [mutation, mutation]
      ])
    }
  )

  it('marks an exception and opens its own permission control from the badge', async () => {
    const yolo = applyAgentPermissionMode({ mode: 'yolo' })
    const settings = projectAgentLaunchSettings({
      ...yolo,
      agentDefaultArgs: { ...yolo.agentDefaultArgs, claude: '' }
    })
    transport.read.mockResolvedValue(settings)
    transport.mutate.mockResolvedValue(settings)
    render(fullPane())
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: "Claude permissions: Agents' own settings" })
    )
    const control = await screen.findByRole('button', { name: 'Claude permissions' })
    await waitFor(() => expect(document.activeElement).toBe(control))
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('menuitemradio', { name: /Approve for me/ }))
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'permissions', agent: 'claude', mode: 'auto', syncNativeChat: true },
        expect.any(AbortSignal)
      )
    )
  })

  it('keeps legacy mixed global state unselected and omits unsupported row Auto', async () => {
    transport.detection.mockReturnValue(['claude', 'gemini'])
    transport.read.mockResolvedValue(
      projectAgentLaunchSettings({
        ...applyAgentPermissionMode({ mode: 'yolo' }),
        agentDefaultArgs: {
          ...applyAgentPermissionMode({ mode: 'yolo' }).agentDefaultArgs,
          claude: ''
        }
      })
    )
    render(fullPane())
    const global = await screen.findByRole('button', { name: 'Agent Permissions' })
    expect(global.textContent).toContain('Mixed')
    const user = userEvent.setup()
    await user.click(global)
    expect(
      screen
        .getAllByRole('menuitemradio')
        .every((item) => item.getAttribute('aria-checked') === 'false')
    ).toBe(true)
    await user.keyboard('{Escape}')
    const gemini = screen.getByText('Gemini', { selector: 'span' }).closest('div.py-3')
    if (!(gemini instanceof HTMLElement)) {
      throw new Error('Missing Gemini row')
    }
    const expand = within(gemini).queryByRole('button', { name: 'Expand agent settings' })
    if (expand) {
      await user.click(expand)
    }
    await user.click(within(gemini).getByRole('button', { name: 'Gemini permissions' }))
    expect(screen.queryByRole('menuitemradio', { name: /Approve for me/ })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: /Full access/ }))
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'permissions', agent: 'gemini', mode: 'yolo', syncNativeChat: true },
        expect.any(AbortSignal)
      )
    )
  })

  it('replaces custom arguments with the expected mode from the row', async () => {
    render(fullPane())
    await screen.findByDisplayValue('--host-marker')
    fireEvent.click(screen.getByRole('button', { name: "Replace with Agents' own settings" }))
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'arguments', agent: 'claude', value: '' },
        expect.any(AbortSignal)
      )
    )
  })

  it('offers the most common mode for a custom-argument row', async () => {
    const yolo = applyAgentPermissionMode({ mode: 'yolo' })
    const settings = projectAgentLaunchSettings({
      ...yolo,
      agentDefaultArgs: { ...yolo.agentDefaultArgs, claude: '--model sonnet', codex: '' }
    })
    transport.read.mockResolvedValue(settings)
    transport.mutate.mockResolvedValue(settings)
    render(fullPane())
    fireEvent.click(await screen.findByRole('button', { name: 'Replace with Full access' }))
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'arguments', agent: 'claude', value: '--dangerously-skip-permissions' },
        expect.any(AbortSignal)
      )
    )
  })

  it.each(['pill', 'row'] as const)(
    'clears the selected default through its %s',
    async (surface) => {
      transport.read.mockResolvedValue({ ...host(), defaultTuiAgent: 'claude' })
      transport.mutate.mockResolvedValue({ ...host(), defaultTuiAgent: 'blank' })
      render(pane(17))
      await screen.findByDisplayValue('--host-marker')
      fireEvent.click(
        screen.getByRole('button', { name: surface === 'pill' ? 'Claude' : 'Default' })
      )
      await waitFor(() =>
        expect(transport.mutate).toHaveBeenCalledWith(
          { environmentId: 'ssh-host', pairingRevision: 17 },
          { type: 'default', agent: 'blank' },
          expect.any(AbortSignal)
        )
      )
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed')).toBe(
          'false'
        )
      )
      expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe(
        'false'
      )
      expect(screen.queryByRole('button', { name: 'No agent (blank terminal)' })).toBeNull()
      transport.mutate.mockResolvedValue({ ...host(), defaultTuiAgent: 'claude' })
      fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed')).toBe(
          'true'
        )
      )
      expect(transport.mutate).toHaveBeenLastCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'default', agent: 'claude' },
        expect.any(AbortSignal)
      )
    }
  )

  it('lets Auto toggle off into an empty selection', async () => {
    transport.mutate.mockResolvedValue({ ...host(), defaultTuiAgent: 'blank' })
    const { container } = render(pane(17))
    await screen.findByDisplayValue('--host-marker')
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    await waitFor(() => expect(container.querySelector('[aria-pressed="true"]')).toBeNull())
    expect(transport.mutate).toHaveBeenCalledWith(
      { environmentId: 'ssh-host', pairingRevision: 17 },
      { type: 'default', agent: 'blank' },
      expect.any(AbortSignal)
    )
    transport.mutate.mockResolvedValue(host())
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('true')
    )
  })

  it('routes the pane to the chosen host and saves arguments without editing desktop defaults', async () => {
    const desktop = createGlobalSettingsFixture({
      activeRuntimeEnvironmentId: null,
      agentDefaultArgs: { claude: '--desktop-marker' },
      agentDefaultEnv: { claude: { DESKTOP_KEY: 'desktop-secret' } }
    })
    useAppStore.setState({
      settings: desktop,
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
        <AgentsPane
          settings={desktop}
          updateSettings={updateDesktop}
          hostScope={{
            target: { kind: 'environment', environmentId: 'ssh-host' },
            available: true
          }}
        />
      </TooltipProvider>
    )
    const args = await screen.findByDisplayValue('--host-marker')
    expect(screen.getByText(/How much agents can do without asking you/)).toBeTruthy()
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
    await selectLegacyPermission('Agent Permissions', "Each agent's own settings")
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        { type: 'permissions', mode: 'manual', syncNativeChat: true },
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
        { type: 'permissions', mode: 'manual', syncNativeChat: true },
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
    expect(transport.mutate.mock.calls[1]?.[1]).toEqual({
      type: 'permissions',
      mode: 'manual',
      syncNativeChat: true
    })
  })

  it.each([false, true])(
    'retains failed Arguments and follows acknowledged host text (typed=%s)',
    async (typed) => {
      const settings = (value: string) =>
        projectAgentLaunchSettings({
          ...(typed ? { agentPermissionDefault: 'ask' as const } : {}),
          agentDefaultArgs: { claude: value }
        })
      transport.read.mockResolvedValue(settings('--host-marker'))
      transport.mutate
        .mockRejectedValueOnce(new Error('unknown acknowledgement'))
        .mockResolvedValue(settings('--host-normalized'))
      const view = render(pane(17))
      const args = await screen.findByDisplayValue('--host-marker')
      fireEvent.change(args, { target: { value: '--next-marker' } })
      fireEvent.blur(args)
      await screen.findByRole('alert')
      expect(args).toHaveProperty('value', '--next-marker')
      fireEvent.blur(args)
      await screen.findByDisplayValue('--host-normalized')
      expect(transport.mutate.mock.calls[1]?.[1]).toEqual({
        type: typed ? 'user-arguments' : 'arguments',
        agent: 'claude',
        value: '--next-marker'
      })
      fireEvent.change(args, { target: { value: '--unsubmitted' } })
      view.rerender(pane(18))
      await screen.findByDisplayValue('--host-marker')
      expect(screen.queryByDisplayValue('--unsubmitted')).toBeNull()
    }
  )

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

it('shows vanished and retained overrides together and only makes the retained agent inherit', async () => {
  const before = {
    agentPermissionDefault: 'full-access' as const,
    agentPermissionOverrides: { codex: 'full-access' as const, claude: 'full-access' as const }
  }
  transport.read.mockResolvedValue(projectAgentLaunchSettings(before))
  transport.mutate
    .mockResolvedValueOnce(
      projectAgentLaunchSettings({
        ...before,
        agentPermissionDefault: 'ask',
        agentPermissionOverrides: { claude: 'full-access' }
      })
    )
    .mockResolvedValueOnce(projectAgentLaunchSettings({ agentPermissionDefault: 'ask' }))
  render(pane(17))
  await screen.findByRole('button', { name: 'Permissions' })
  await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: /Ask for approval/ }))
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
  expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
    '1 agent still uses their own permission setting:'
  )
  const { details, follow } = permissionNotice()
  expect(details.textContent).toContain('Claude · Full access')
  expect(details.textContent).toContain('Codex now follows Ask for approval')
  await follow()
  await waitFor(() => expect(transport.mutate).toHaveBeenCalledTimes(2))
  expect(transport.mutate.mock.calls.map((call) => call[1])).toEqual([
    { type: 'permission', choice: 'ask' },
    { type: 'permission', agent: 'claude', choice: 'default' }
  ])
})
