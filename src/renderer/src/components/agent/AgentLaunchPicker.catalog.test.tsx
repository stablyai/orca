// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { agentPickerLaunchInputs } from '../../../../shared/agent-launch/picker/agent-launch-picker'

import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import { TooltipProvider } from '@/components/ui/tooltip'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const previous = useAppStore.getState()
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  useAppStore.setState(previous, true)
  mocks.call.mockReset()
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it.each(['codex', 'pi'] as const)(
  'offers an account-only model for %s with an unlearned old-host registry and carries it to launch',
  async (agent) => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: { get: () => ({ platform: 'darwin' }) } }
    })
    useAppStore.setState({ settings: getDefaultSettings('/synthetic') })
    mocks.call.mockResolvedValue({
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'account-only',
          label: 'Account model',
          isDefault: false,
          efforts: []
        }
      ]
    })
    const picks: unknown[] = []
    render(
      <TooltipProvider>
        <AgentLaunchPicker
          agent={agent}
          model={{
            state: 'settled',
            rows: [{ agent, kind: 'chat' }],
            detection: {
              detectedIds: [agent],
              isLoading: false,
              isRefreshing: false,
              detectionFailed: false,
              needsServerUpdate: false,
              refresh: async () => [agent]
            }
          }}
          onPick={(_agent, draft) => {
            if (!draft) {
              throw new Error('Expected a model setup draft')
            }
            picks.push(agentPickerLaunchInputs(draft))
          }}
        />
      </TooltipProvider>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select agent' }))
    const search = await screen.findByRole('textbox')
    fireEvent.change(search, { target: { value: 'Account model' } })
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /Account model/ })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Account model/ }))
    expect(picks).toEqual([
      expect.objectContaining({
        sessionOptions: expect.objectContaining({ model: 'account-only' })
      })
    ])
  }
)
