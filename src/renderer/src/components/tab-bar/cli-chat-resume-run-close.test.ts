import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import type * as FrameDrawnChatTabPlacementModule from '@/lib/frame-drawn-chat-tab-placement'
import type * as CloseTerminalModule from './cli-chat-resume-close-terminal'

const mocks = vi.hoisted(() => {
  const state: { source: CliChatResumeSource | null } = { source: null }
  return {
    ...state,
    sourceCapability: vi.fn(),
    closeCapability: vi.fn(),
    capabilityState: vi.fn(),
    closeTerminal: vi.fn(),
    probe: vi.fn(),
    createCapability: vi.fn(),
    call: vi.fn(),
    createSupport: vi.fn(),
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
vi.mock('@/runtime/structured-agent-session-client', () => ({
  structuredAgentSessionHostSupports: mocks.closeCapability,
  structuredAgentSessionHostCapabilityState: async (...args: unknown[]) =>
    (await mocks.capabilityState(...args)) ??
    ((await mocks.closeCapability(...args)) ? 'supported' : 'unsupported'),
  supportsStructuredAgentSessionCliSource: mocks.sourceCapability,
  supportsStructuredAgentSessionCreateMessage: mocks.createCapability,
  callStructuredAgentSession: (...args: unknown[]) =>
    args[1] === 'agentSession.createSupport' ? mocks.createSupport(args[2]) : mocks.call(...args)
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
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
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeCapabilityProofModule>()),
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { useAppStore } from '@/store'

import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { runCliChatResume } from './cli-chat-resume-run'

import {
  SOURCE,
  resetCliChatResumeRun,
  showAgentInSource,
  tabs
} from './cli-chat-resume-run.test-fixture'

const creates = () => mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  main?.close()
  main = undefined
})
beforeEach(async () => {
  resetCliChatResumeRun(mocks)
  mocks.createSupport.mockResolvedValue({ supported: true })
  main = await drawTabsFromMain(useAppStore)
})

describe('close terminal then continue on capable hosts', () => {
  beforeEach(() => {
    mocks.closeCapability.mockResolvedValue(true)
    showAgentInSource()
  })

  it('leaves a tab the user picked while the chat waited on the close', async () => {
    mocks.closeTerminal.mockImplementation(async (_source, _current, hooks) => {
      useAppStore.getState().createUnifiedTab('wt-1', 'agent-session', {
        id: 'picked',
        entityId: 'picked-chat'
      })
      expect(resolveWebSessionVisibleTabId(useAppStore.getState(), 'wt-1')).toBe('picked')
      hooks.prepared()
      hooks.closing()
      mocks.source = null
      return true
    })
    await runCliChatResume(SOURCE)
    await main?.settle()
    expect(creates()).toHaveLength(1)
    expect(resolveWebSessionVisibleTabId(useAppStore.getState(), 'wt-1')).toBe('picked')
  })

  // Joining it would re-send an unconfirmed chat's create beside the still-running CLI.
  it.each(['pending', 'visibility-unknown'])(
    'shows a %s chat already opening this conversation and keeps the terminal',
    async (lifecycle) => {
      // Its create never answers, or its reply is lost and the host can't be asked whether it exists.
      const answer = mocks.call.getMockImplementation()
      mocks.call.mockImplementation((...args: unknown[]) =>
        args[1] !== 'agentSession.create'
          ? answer?.(...args)
          : lifecycle === 'pending'
            ? new Promise(() => undefined)
            : Promise.reject(new Error('response lost'))
      )
      const other = startStructuredAgentLaunch('wt-1', 'claude', {
        requestId: 'other-resume',
        resumeFrom: { providerSessionId: SOURCE.providerSessionId }
      })
      await vi.waitFor(() => {
        expect(creates().length).toBeGreaterThan(0)
        expect(getStructuredAgentSessionLaunchLifecycle('wt-1', other.sessionId)).toBe(lifecycle)
      })
      const sent = creates().length
      await runCliChatResume(SOURCE, true)
      await main?.settle()
      expect(mocks.closeTerminal).not.toHaveBeenCalled()
      expect(tabs().map((tab) => tab.entityId)).toEqual([other.sessionId])
      expect(creates()).toHaveLength(sent)
      expect(mocks.toast).not.toHaveBeenCalled()
    }
  )
})
