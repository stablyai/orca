// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type * as SessionOwner from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { runConversationSwitch } from './conversation-surface-switch'
import { pendingNativeChatCliSwitches } from './pending-conversation-surface-switches'
const mocks = vi.hoisted(() => {
  function makeTarget(): { current: RuntimeClientTarget } {
    return { current: { kind: 'local' } }
  }
  return {
    target: makeTarget(),
    support: vi.fn(),
    rpc: vi.fn(),
    capture: vi.fn(),
    prepare: vi.fn(),
    pairedRefresh: vi.fn(),
    call: vi.fn(),
    legacy: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    error: vi.fn(),
    info: vi.fn(),
    reader: vi.fn(),
    listeners: new Set<() => void>(),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-owner', async (original) => ({
  ...(await original<typeof SessionOwner>()),
  structuredAgentSessionTargetForHost: () => mocks.target.current
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/tab-bar/cli-chat-resume-terminal-capture', () => ({
  captureSourceTerminal: mocks.capture
}))
vi.mock('./ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepare
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.pairedRefresh
}))
vi.mock('./in-place-switch-support', () => ({
  useInPlaceSwitchCapability: () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    subscribe: mocks.subscribe,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: mocks.reader
}))
vi.mock('@/components/tab-bar/cli-chat-resume-run', () => ({
  runLegacyCliChatResume: mocks.legacy
}))
vi.mock('@/components/tab-bar/native-chat-cli-switch-run', () => ({
  runLegacyNativeChatCliSwitch: mocks.legacy
}))
vi.mock('@/components/tab-bar/cli-chat-resume-feedback', () => ({
  switchIntoOwnerLegacy: mocks.legacy
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/components/right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.legacy,
  adoptingAgentOnHost: async (agent: string) => agent
}))

const subject = {
  direction: 'terminal' as const,
  executionHostId: 'local',
  workspaceId: 'workspace',
  sessionId: 'codex_chat',
  agent: 'codex' as const,
  chatTabId: 'source'
}
beforeEach(() => {
  vi.clearAllMocks()
  createTabsSliceMockApi()
  mocks.target.current = { kind: 'local' }
  mocks.rpc.mockResolvedValue({})
  mocks.pairedRefresh.mockResolvedValue(undefined)
  mocks.capture.mockResolvedValue({
    handle: 'terminal-source',
    incarnationId: 'incarnation',
    presentation: {}
  })
  mocks.reader.mockReturnValue(undefined)
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
})

it('sends one switch, shows pending only while the host runs it, and settles without a message', async () => {
  mocks.support.mockResolvedValue(true)
  let pendingDuringCall = false
  mocks.call.mockImplementation(async () => {
    pendingDuringCall = pendingNativeChatCliSwitches.size > 0
    return { status: 'completed', sessionId: subject.sessionId }
  })
  await expect(runConversationSwitch(subject)).resolves.toBe(true)
  expect(pendingDuringCall).toBe(true)
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  const [, method, params] = mocks.call.mock.calls[0]!
  expect(method).toBe('agentSession.switchToTerminal')
  expect(params).toMatchObject({
    sessionId: subject.sessionId,
    execution: { invocationId: expect.any(String), sourceTabId: 'source' }
  })
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.info).not.toHaveBeenCalled()
})

it('reports a refused switch once and leaves nothing pending', async () => {
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({
    status: 'refused',
    sessionId: subject.sessionId,
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'messagesUnsettled' } }
  })
  await expect(runConversationSwitch(subject)).resolves.toBe(false)
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  // A second click is a fresh switch, never swallowed by a stale pending entry.
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  await expect(runConversationSwitch(subject)).resolves.toBe(true)
})

it('falls back to the legacy path when the host cannot switch in place', async () => {
  mocks.support.mockResolvedValue(false)
  await expect(runConversationSwitch(subject)).resolves.toBe(false)
  expect(mocks.legacy).toHaveBeenCalledOnce()
  expect(mocks.call).not.toHaveBeenCalled()
})
