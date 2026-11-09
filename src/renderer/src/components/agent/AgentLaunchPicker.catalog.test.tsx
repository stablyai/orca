// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sourceEntry } from './agent-launch-picker-sources.test-fixture'
import {
  agentPickerDraft,
  agentPickerFreshLaunchInputs
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  agentPickerLaunchInputs,
  type AgentPickerDraft
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
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
          onPick={(_agent, draft) => picks.push(agentPickerLaunchInputs(draft as AgentPickerDraft))}
        />
      </TooltipProvider>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select agent' }))
    const search = await screen.findByPlaceholderText('Search agents and setups…')
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

it('searches a terminal dialog preset with a chat-default entry and launches its exact CLI selection', async () => {
  const entry = { ...sourceEntry('chat'), terminal: { options: { effort: 'high' } } }
  const picks = vi.fn()
  render(
    <TooltipProvider>
      <AgentLaunchPicker
        agent="antigravity"
        entries={[entry]}
        value={agentPickerDraft(entry, 'terminal')}
        model={{
          state: 'settled',
          rows: [{ agent: 'antigravity', kind: 'chat' }],
          detection: {
            detectedIds: ['antigravity'],
            isLoading: false,
            isRefreshing: false,
            detectionFailed: false,
            needsServerUpdate: false,
            refresh: async () => ['antigravity']
          }
        }}
        onPick={(_agent, draft) =>
          picks(
            agentPickerFreshLaunchInputs(
              draft!,
              { surface: 'terminal', executionHostId: 'local' },
              entry
            )
          )
        }
      />
    </TooltipProvider>
  )
  await userEvent.setup().click(screen.getByRole('button', { name: 'Select agent' }))
  fireEvent.change(await screen.findByPlaceholderText('Search agents and setups…'), {
    target: { value: 'Flash Low' }
  })
  fireEvent.click(await screen.findByRole('menuitem', { name: /Gemini 3.8 Flash \(Low\)/ }))
  expect(picks).toHaveBeenCalledWith(
    expect.objectContaining({ sessionOptions: { model: 'gemini-3.8-flash-low' } })
  )
  expect(mocks.call).not.toHaveBeenCalled()
})
