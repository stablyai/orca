import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { routeQuestionAnsweredInference } from './agent-question-inference-route'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: (ptyId: string) =>
    ptyId === 'remote'
      ? { target: { kind: 'environment', environmentId: 'ssh-host' }, terminal: 'handle-1' }
      : null
}))

const localInfer = vi.fn(async () => true)
const request = {
  paneKey: 'tab:pane',
  baselineUpdatedAt: 1,
  baselineStateStartedAt: 1,
  baselinePrompt: 'Set up a db',
  baselineAgentType: 'codex' as const
}

beforeEach(() => {
  vi.stubGlobal('window', { api: { agentStatus: { inferQuestionAnswered: localInfer } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('keeps local panes on desktop main', async () => {
  expect(await routeQuestionAnsweredInference('local', { ...request, codexSkip: true })).toBe(true)
  expect(localInfer).toHaveBeenCalled()
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})

it("sends a remote pane's Codex skip to the runtime that owns its hook state", async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({ applied: true })
  expect(await routeQuestionAnsweredInference('remote', { ...request, codexSkip: true })).toBe(true)
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'ssh-host' },
    'terminal.inferCodexQuestionSkip',
    { terminal: 'handle-1', prompt: 'Set up a db' },
    expect.anything()
  )
  expect(localInfer).not.toHaveBeenCalled()
})

it('drops other remote inferences, which desktop main could not apply either', async () => {
  expect(await routeQuestionAnsweredInference('remote', request)).toBe(false)
  expect(callRuntimeRpc).not.toHaveBeenCalled()
  expect(localInfer).not.toHaveBeenCalled()
})
