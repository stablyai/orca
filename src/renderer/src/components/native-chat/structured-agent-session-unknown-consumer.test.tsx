// @vitest-environment happy-dom

import { useRef } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostCapability from '@/runtime/structured-agent-session-host-capability'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

const rpc = vi.hoisted(() => ({ call: vi.fn(), settings: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc.call,
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} }),
  supportsStructuredAgentSessionQuietRepeatedStop: async () => true
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.settings }))
vi.mock('@/runtime/structured-agent-session-host-capability', async (original) => ({
  ...(await original<typeof HostCapability>()),
  useStructuredAgentSessionHostCapability: () => true,
  useStructuredAgentSessionOwnPermissionState: () => 'unsupported'
}))

const target = { kind: 'local' } as const
const unknown: AgentSessionOptionsResult = {
  models: [{ id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }],
  current: {},
  conversationCommands: ['clear']
}

let send: ReturnType<typeof useStructuredAgentSessionSendOptions>
function Chat() {
  const stateRef = useRef({ fence: 1 })
  const { mutate } = useStructuredAgentSessionMutate({
    sessionId: 'unknown-consumer',
    target,
    enabled: true,
    stateRef
  })
  const options = useStructuredAgentSessionOptions({
    agent: 'claude',
    sessionId: 'unknown-consumer',
    target,
    transportEnabled: true,
    isVisible: true,
    providerVisible: true,
    fence: 1,
    turnId: null,
    unloadedTurnRevisions: undefined,
    mutate
  })
  send = useStructuredAgentSessionSendOptions('unknown-consumer', undefined, options.sendSource)
  return (
    <NativeChatSessionOptionPickers
      surface={options.optionSurface}
      snapshot={options.optionSnapshot}
      isWorking={false}
    />
  )
}

afterEach(() => {
  cleanup()
  resetHostModelCatalogSnapshotsForTests()
  vi.clearAllMocks()
})

it('keeps an unknown host answer unselected until an actual pick is displayed, remembered and sent', async () => {
  let answer = unknown
  rpc.settings.mockResolvedValue(undefined)
  rpc.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.modelCatalog') {
      return { origin: 'unknown' }
    }
    if (method === 'agentSession.options') {
      return answer
    }
    if (method === 'agentSession.setOption') {
      answer = {
        ...answer,
        current: {
          ...answer.current,
          model: params.value,
          acceptedInputSources: { model: 'saved' }
        }
      }
      return {
        ok: true,
        replayed: false,
        value: { key: params.key, value: params.value, options: { model: params.value } }
      }
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  render(
    <TooltipProvider>
      <Chat />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith(
      target,
      'agentSession.options',
      { sessionId: 'unknown-consumer' },
      {}
    )
  )
  await waitFor(() => expect(screen.getByRole('button', { name: /^Model$/ })).toBeDefined())
  expect(send()).toEqual({ selection: {} })
  expect(rpc.settings).not.toHaveBeenCalled()
  expect(
    rpc.call.mock.calls.filter(([, method]) => method === 'agentSession.setOption')
  ).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /^Model$/ }))
  const sonnet = await screen.findByRole('option', { name: /^Sonnet\b/ })
  expect(sonnet.getAttribute('data-value')).toBe('sonnet')
  expect(sonnet.getAttribute('aria-current')).toBeNull()
  fireEvent.click(sonnet)
  await waitFor(() => expect(send()).toEqual({ selection: { model: 'sonnet' } }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Model Sonnet/ })).toBeDefined())
  await waitFor(() =>
    expect(rpc.settings).toHaveBeenCalledWith(
      target,
      'settings.mutateNativeChatSessionOptions',
      {
        type: 'apply-picks',
        agent: 'claude',
        picks: [{ modelId: 'sonnet', optionId: 'model', value: 'sonnet' }]
      },
      {}
    )
  )
})
