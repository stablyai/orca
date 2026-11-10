import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import type { StructuredAgentSessionCreateParams } from '../../../../shared/agent-session/structured-agent-session-create'
import type * as FrameDrawnChatTabPlacementModule from '@/lib/frame-drawn-chat-tab-placement'
import type * as CloseTerminalModule from './cli-chat-resume-close-terminal'

const mocks = vi.hoisted(() => {
  const state: { source: CliChatResumeSource | null } = { source: null }
  return {
    ...state,
    sourceCapability: vi.fn(),
    closeCapability: vi.fn(),
    closeTerminal: vi.fn(),
    probe: vi.fn(),
    createCapability: vi.fn(),
    call: vi.fn(),
    toast: vi.fn(),
    activate: vi.fn(async () => true),
    frameDrawn: false
  }
})
vi.mock('./cli-chat-resume-close-terminal', async (importOriginal) => ({
  ...(await importOriginal<typeof CloseTerminalModule>()),
  closeCliChatResumeTerminal: mocks.closeTerminal
}))
vi.mock('./cli-chat-resume-source', () => ({ resolveCliChatResumeSource: () => mocks.source }))
vi.mock('../terminal/pty-running-work-probe', () => ({ probePtyRunningWork: mocks.probe }))
vi.mock(
  '../../runtime/native-chat/host-capabilities/structured-agent-session-host-support',
  () => ({
    structuredAgentSessionHostSupports: mocks.closeCapability,
    structuredAgentSessionHostCapabilityState: async (...args: unknown[]) =>
      (await mocks.closeCapability(...args)) ? 'supported' : 'unsupported',
    supportsStructuredAgentSessionCliSource: mocks.sourceCapability,
    supportsStructuredAgentSessionCreateMessage: mocks.createCapability
  })
)

vi.mock('../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: (...args: unknown[]) =>
    args[1] === 'agentSession.createSupport'
      ? Promise.resolve({ supported: true })
      : mocks.call(...args)
}))
vi.mock('@/runtime/native-chat/tab-inventory/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: async () => {
    throw new Error('Reply unavailable')
  }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-create-hydration', () => ({
  publishStructuredAgentSessionCreateHydration: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
// A frame-drawn server workspace's create carries the tab's place, read as it is sent.
vi.mock('@/lib/frame-drawn-chat-tab-placement', async (importOriginal) => {
  const actual = await importOriginal<typeof FrameDrawnChatTabPlacementModule>()
  return {
    ...actual,
    withFrameDrawnChatTabPlacement: (
      intent: Parameters<typeof actual.withFrameDrawnChatTabPlacement>[0]
    ) =>
      mocks.frameDrawn
        ? { ...intent.params, tabPlacement: { groupId: 'g-1' } }
        : actual.withFrameDrawnChatTabPlacement(intent)
  }
})
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate
}))
// Switch-on, main opens the chat's tab and its frame draws it.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeCapabilityProofModule>()),
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { useAppStore } from '@/store'

import { runCliChatResume } from './cli-chat-resume-run'

import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/workspace/activation/initial-surface/empty-workspace-default-surface-claims'

import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'

import { SOURCE, deferred, resetCliChatResumeRun, tabs } from './cli-chat-resume-run.test-fixture'

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  main?.close()
  main = undefined
})
beforeEach(async () => {
  resetCliChatResumeRun(mocks)
  main = await drawTabsFromMain(useAppStore)
})

describe('CLI identity resume through the existing launch owner', () => {
  it('shares pending, sends only an advertised source, and survives source closure after dispatch', async () => {
    const reply = deferred<unknown>()
    mocks.call.mockReturnValue(reply.promise)
    const running = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await runCliChatResume({ ...SOURCE, paneKey: 'another-pane' })
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(tabs()).toEqual([])
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(true)
    const params: StructuredAgentSessionCreateParams = mocks.call.mock.calls[0][2]
    expect(params.resumeFrom).toEqual({
      providerSessionId: 'provider-1',
      cliSource: { workspaceId: 'wt-1', paneKey: 'tab-1:leaf' }
    })
    mocks.source = null
    useAppStore.setState({})
    reply.resolve({ ok: true, value: { sessionId: params.envelope.sessionId, fence: 1 } })
    await running
    expect(tabs()).toHaveLength(1)
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(false)
  })
})
