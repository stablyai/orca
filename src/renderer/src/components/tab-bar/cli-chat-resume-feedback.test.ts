import { beforeEach, expect, it, vi } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  resume: vi.fn(),
  call: vi.fn(),
  activate: vi.fn()
}))
vi.mock('../native-chat/native-chat-held-terminal', () => ({ toastHeldTerminal: mocks.toast }))
vi.mock('@/lib/structured-agent-session-launch-surface', () => ({
  captureStructuredLaunchSurfaceAddress: () => ({
    worktreeId: 'w',
    precedingTabIds: ['before', 'source']
  })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsInPlaceSwitch: async () => true
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate,
  activateAiVaultStructuredSessionVerified: mocks.activate
}))
import { startCliChatReturn, toastCliChatResumeFailure } from './cli-chat-resume-feedback'
const source: CliChatResumeSource = {
  tabId: 'source',
  workspaceId: 'w',
  paneKey: 'source:11111111-1111-4111-8111-111111111111',
  agent: 'codex',
  providerSessionId: 'conversation',
  executionHostId: 'local',
  ptyId: 'pty'
}
const refusal = {
  code: 'agent_session_operation_invalid',
  message: 'held',
  details: {
    reason: 'conversationOpenInTerminal',
    terminal: { paneKey: 'source:11111111-1111-4111-8111-111111111111', worktreeId: 'w' }
  }
}
beforeEach(() => vi.clearAllMocks())
it('offers only Close for a refused create; a later continuation remains an explicit action', () => {
  toastCliChatResumeFailure(source, Object.assign(new Error('held'), { refusal }))
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ terminal: refusal.details.terminal, executionHostId: 'local' })
  )
  expect(mocks.toast.mock.calls[0][0]).not.toHaveProperty('onContinue')
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
})
it('does not repeat a refused switch or activate its chat automatically', async () => {
  mocks.call.mockResolvedValueOnce({ ok: false, refusal })
  expect(await startCliChatReturn(source, 'existing', { kind: 'local' })).toBe(false)
  expect(mocks.toast.mock.calls[0][0]).not.toHaveProperty('onContinue')
  expect(mocks.call).toHaveBeenCalledOnce()
  expect(mocks.activate).not.toHaveBeenCalled()
  mocks.call.mockResolvedValueOnce({ ok: true })
  expect(await startCliChatReturn(source, 'existing', { kind: 'local' })).toBe(true)
  expect(mocks.call).toHaveBeenCalledTimes(2)
})
