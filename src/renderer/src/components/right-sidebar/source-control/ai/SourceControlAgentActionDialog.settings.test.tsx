// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import { agentPickerChoiceSeeds } from '../../../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import type { AgentPickerEntry } from '../../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NewTabAgentMenuModel } from '../../../tab-bar/use-new-tab-agent-menu-rows'
import { mountSourceDialog } from '../panel/source-control-action-dialog.test-fixture'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
vi.mock('../../../agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: (_id: string | undefined, model: NewTabAgentMenuModel) =>
    model.state !== 'settled'
      ? []
      : [...new Set(model.rows.map((row) => row.agent))].map(
          (agent: AgentPickerEntry['agent']): AgentPickerEntry => ({
            agent,
            label: formatAgentTypeLabel(agent),
            ownerKey: `action-${agent}`,
            rows: model.rows.filter((row) => row.agent === agent),
            surfaces: ['chat', 'terminal'],
            defaultSurface: model.rows.some((row) => row.agent === agent && row.kind === 'chat')
              ? 'chat'
              : 'terminal',
            ...agentPickerChoiceSeeds(agent, useAppStore.getState().settings),
            catalog: {
              origin: 'probe',
              fetchedAt: 1,
              models: (agent === 'claude' ? ['opus', 'sonnet'] : ['o3', 'gpt-5.5']).map(
                (id, index) => ({
                  id,
                  label: id,
                  isDefault: index === 0,
                  defaultEffort: 'high',
                  efforts: [
                    { value: 'low', label: 'Low' },
                    { value: 'high', label: 'High' }
                  ],
                  supportsFastMode: true,
                  ...(agent === 'codex'
                    ? { serviceTiers: [{ value: 'priority', label: 'Fast' }] }
                    : {})
                })
              )
            }
          })
        )
}))
const initial = useAppStore.getState()
const originalApi = window.api
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  setLocalRuntimeCapabilitiesForTests(null)
})

it.each(['claude', 'codex'] as const)(
  'edits %s in the common panel, saves and starts the resulting recipe',
  async (agent) => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        preflight: { detectAgents: async () => ['claude', 'codex'] },
        runtime: { call: async () => ({ ok: true, result: { agents: [] } }) },
        platform: {
          get: () => ({
            platform: 'darwin',
            osRelease: '',
            arch: 'arm64',
            shell: '/bin/sh',
            displayServer: null,
            windowMaterial: 'off'
          })
        }
      }
    })
    const f = mountSourceDialog({ agentId: agent, surface: 'terminal', agentArgs: '--verbose' }, {})
    const user = userEvent.setup()
    const label = agent === 'claude' ? 'Claude' : 'Codex'
    const model = agent === 'claude' ? 'sonnet' : 'gpt-5.5'
    const trigger = screen.getByRole('button', { name: 'Select agent' })
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: `Configure ${label}` }))
    await user.click(screen.getByRole('option', { name: model }))
    await user.click(screen.getByRole('radio', { name: 'Low' }))
    await user.click(screen.getByRole('button', { name: `${label} permissions` }))
    await user.click(screen.getByRole('menuitemradio', { name: /^Full access/ }))
    await user.click(
      agent === 'claude' ? screen.getByRole('switch') : screen.getByRole('radio', { name: 'Fast' })
    )
    const text = screen.queryByRole('textbox', { name: 'Arguments' })
    if (!text) {
      await user.click(screen.getByRole('button', { name: 'Toggle Arguments' }))
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
      target: { value: '--add-dir docs' }
    })
    await user.click(screen.getByRole('button', { name: 'Launch terminal' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull())
    const accepted = structuredClone(f.controller.recipe)
    await user.click(screen.getByRole('button', { name: 'Select agent' }))
    await user.click(screen.getByRole('button', { name: `Configure ${label}` }))
    if (!screen.queryByRole('textbox', { name: 'Arguments' })) {
      await user.click(screen.getByRole('button', { name: 'Toggle Arguments' }))
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
      target: { value: '--add-dir docs --verbose' }
    })
    await user.click(screen.getByRole('button', { name: `Configure ${label}` }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: `Configure ${label}` })).toBeNull()
    await user.keyboard('{Escape}')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt template' }), {
      target: { value: 'RETAIN {basePrompt}' }
    })
    await user.click(screen.getByRole('button', { name: 'Select agent' }))
    await user.click(screen.getByRole('menuitem', { name: 'Agent settings…' }))
    const agents = await screen.findByRole('dialog', { name: 'Agents' })
    expect(within(agents).getAllByRole('switch').length).toBeGreaterThan(0)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reset' }))
    expect(f.controller.recipe).toEqual({
      ...accepted,
      commandInputTemplate: 'RETAIN {basePrompt}'
    })
    expect(screen.getByRole('textbox', { name: 'Prompt template' })).toHaveProperty(
      'value',
      'RETAIN {basePrompt}'
    )
    expect(f.persist).not.toHaveBeenCalled()
    expect(f.onStart).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Select agent' }))
    await user.click(screen.getByRole('button', { name: `Configure ${label}` }))
    if (!screen.queryByRole('textbox', { name: 'Arguments' })) {
      await user.click(screen.getByRole('button', { name: 'Toggle Arguments' }))
    }
    expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
      'value',
      '--add-dir docs --verbose'
    )
    await user.click(screen.getByRole('button', { name: 'Launch terminal' }))

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
    )
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    expect(f.onStart.mock.calls[0][0]).toMatchObject({
      agent,
      sessionOptions: {
        model,
        effort: 'low',
        permissionMode: 'full-access',
        ...(agent === 'claude' ? { fastMode: 'true' } : { serviceTier: 'priority' })
      }
    })
    expect(f.onStart.mock.calls[0][0].agentArgs).toContain('--add-dir docs')
    expect(f.persist).toHaveBeenCalledOnce()
    if (agent === 'codex') {
      await user.click(trigger)
      await user.click(screen.getByRole('menuitem', { name: 'Agent settings…' }))
      expect(await screen.findByRole('dialog', { name: 'Agents' })).toBeTruthy()
      f.view.unmount()
      const replacement = document.createElement('button')
      document.body.append(replacement)
      replacement.focus()
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Agents' })).toBeNull())
      // Drain the real deferred Radix close callback before checking ownership.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      expect(trigger.isConnected).toBe(false)
      expect(document.activeElement).toBe(replacement)
      replacement.remove()
    }
  }
)
