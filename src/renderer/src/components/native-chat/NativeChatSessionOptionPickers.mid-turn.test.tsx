// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc.call,
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => true,
  useStructuredAgentSessionOwnPermissionState: () => 'supported',
  structuredAgentSessionHostKey: () => 'local'
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: () => Promise.resolve()
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'

const target = { kind: 'local' } as const
const sessionId = 'mid-turn-picker'
afterEach(() => {
  cleanup()
  forgetStructuredSessionSelection(sessionId)
})

it('picks effort during a running turn, saves it to the chat, and captures it only for the next message', async () => {
  let effort = 'high'
  const sent: unknown[] = []
  const answer = () => ({
    models: [
      {
        id: 'opus',
        label: 'Opus',
        efforts: ['low', 'high'].map((value) => ({ value, label: value }))
      }
    ],
    current: { model: 'opus', effort, acceptedInputSources: { model: 'saved', effort: 'saved' } }
  })
  rpc.call.mockImplementation(async (_target, method, input) => {
    if (method === 'agentSession.options') {
      return answer()
    }
    if (method === 'agentSession.modelCatalog') {
      return { origin: 'unknown' }
    }
    if (method === 'agentSession.setOption') {
      effort = input.value
      return { ok: true, value: { ...input, options: { model: 'opus', effort } } }
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  function Composer({ working = true }: { working?: boolean }) {
    const options = useStructuredAgentSessionOptions({
      agent: 'claude',
      sessionId,
      target,
      fence: 1,
      transportEnabled: true,
      isVisible: true,
      providerVisible: true,
      providerRunning: true,
      turnId: working ? 'running-turn' : null,
      unloadedTurnRevisions: undefined,
      mutate: async () => null
    })
    const capture = useStructuredAgentSessionSendOptions(sessionId, undefined, options.sendSource)
    return (
      <TooltipProvider>
        <NativeChatSessionOptionPickers
          surface={options.optionSurface}
          snapshot={options.optionSnapshot}
          isWorking={working}
        />
        <button onClick={() => sent.push(capture())}>Send next message</button>
      </TooltipProvider>
    )
  }
  const { rerender } = render(<Composer />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Model Opus/ }).textContent).toContain('High')
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send next message' }))
  const running = sent[0]
  const trigger = screen.getByRole('button', { name: /Model Opus/ })
  expect(trigger).toHaveProperty('disabled', false)
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('radio', { name: 'Low' }))
  await waitFor(() =>
    expect(
      rpc.call.mock.calls.some(
        ([, method, input]) =>
          method === 'agentSession.setOption' && input.key === 'effort' && input.value === 'low'
      )
    ).toBe(true)
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Model Opus/ }).textContent).toContain('Low')
  )
  rerender(<Composer working={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Send next message' }))
  expect(sent[1]).toEqual({ selection: { model: 'opus', effort: 'low' } })
  expect(running).toEqual({ selection: { model: 'opus', effort: 'high' } })
  expect(
    rpc.call.mock.calls.every(([, method]) => !['turn/steer', 'turn/start'].includes(method))
  ).toBe(true)
})
