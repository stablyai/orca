// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import type * as FrameDrawnChatTabPlacementModule from '@/lib/frame-drawn-chat-tab-placement'

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
vi.mock('./cli-chat-resume-close-terminal', () => ({
  closeCliChatResumeTerminal: mocks.closeTerminal
}))
vi.mock('./cli-chat-resume-source', () => ({ resolveCliChatResumeSource: () => mocks.source }))
vi.mock('../terminal/pty-running-work-probe', () => ({ probePtyRunningWork: mocks.probe }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  structuredAgentSessionHostSupports: mocks.closeCapability,
  supportsStructuredAgentSessionCliSource: mocks.sourceCapability,
  supportsStructuredAgentSessionCreateMessage: mocks.createCapability,
  callStructuredAgentSession: (...args: unknown[]) =>
    args[1] === 'agentSession.createSupport'
      ? Promise.resolve({ supported: true })
      : mocks.call(...args)
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
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal()),
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { useAppStore } from '@/store'
import { getStructuredAgentSessionLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { runCliChatResume } from './cli-chat-resume-run'
import {
  SOURCE,
  deferred,
  held,
  refuse,
  resetCliChatResumeRun,
  row,
  showAgentInSource,
  tabs
} from './cli-chat-resume-run.test-fixture'

const creates = () => mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
/** What the chat that took the terminal's place says about its failed start. */
const chatFailure = () => {
  const [chat] = tabs()
  return chat ? getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId) : null
}
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

describe('close terminal then continue on capable hosts', () => {
  beforeEach(() => {
    mocks.closeCapability.mockResolvedValue(true)
    showAgentInSource()
  })

  it('shows the chat before its only terminal closes and creates it after the exit', async () => {
    mocks.closeTerminal.mockImplementation(async (_source, _current, hooks) => {
      expect(tabs().map((tab) => tab.contentType)).toEqual(['agent-session'])
      expect(useAppStore.getState().activeTabType).toBe('agent-session')
      expect(mocks.call).not.toHaveBeenCalled()
      hooks.prepared()
      hooks.closing()
      mocks.source = null
      return true
    })
    await runCliChatResume(SOURCE)
    await main?.settle()
    expect(mocks.closeTerminal).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls[0][2].resumeFrom).toEqual({
      providerSessionId: SOURCE.providerSessionId
    })
    const state = useAppStore.getState()
    expect(state.activeWorktreeId).toBe('wt-1')
    expect(state.activeTabType).toBe('agent-session')
    expect(tabs().map((tab) => tab.contentType)).toEqual(['agent-session'])
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('says an unverified stop once, in the chat that took the terminal’s place', async () => {
    mocks.closeTerminal.mockImplementation(async (_source, _current, hooks) => {
      hooks.closing()
      throw new Error('private negative stop sentinel')
    })
    await runCliChatResume(SOURCE)
    await vi.waitFor(() =>
      expect(chatFailure()?.causeText).toBe(
        "Orca closed Claude's terminal but couldn't confirm Claude stopped. Check the host connection, then try again."
      )
    )
    expect(creates()).toEqual([])
    expect(tabs().map((tab) => tab.contentType)).toEqual(['agent-session'])
    expect(mocks.toast).not.toHaveBeenCalled()
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

  it('keeps the terminal, quietly, when the user closes the pending chat first', async () => {
    mocks.closeTerminal.mockImplementation(async (_source, current, hooks) => {
      useAppStore.getState().closeUnifiedTab(tabs()[0].id)
      await main?.settle()
      hooks.prepared()
      if (!current()) {
        hooks.refused()
        return false
      }
      hooks.closing()
      return true
    })
    await runCliChatResume(SOURCE)
    expect(creates()).toEqual([])
    expect(tabs()).toEqual([])
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  // What the host reads in the clicked pane decides whether continuing stops it or its prompt asks.
  it.each([
    {
      name: 'the agent runs',
      probe: { verdict: 'live', foregroundProcess: 'claude' },
      asks: false
    },
    { name: 'the read is unverifiable', probe: { verdict: 'unverifiable' }, asks: false },
    { name: 'no terminal is bound here', probe: null, asks: false },
    {
      name: 'another job runs after the agent quit',
      probe: { verdict: 'live', foregroundProcess: 'vim' },
      asks: true
    }
  ])('closes the terminal when $name', async ({ probe, asks }) => {
    if (probe) {
      mocks.probe.mockImplementation(async ([ptyId]: string[]) => [
        { ptyId, timedOut: false, remote: false, ...probe }
      ])
    } else {
      useAppStore.setState((state) => ({
        terminalLayoutsByTabId: {
          'tab-1': { ...state.terminalLayoutsByTabId['tab-1'], ptyIdsByLeafId: {} }
        }
      }))
    }
    // Its own running-process prompt asks only without consent; the user cancels it.
    mocks.closeTerminal.mockImplementation(async (_source, _current, hooks, _signal, consents) => {
      hooks.prepared()
      if (!consents) {
        return false
      }
      hooks.closing()
      return true
    })
    await runCliChatResume(SOURCE)
    expect(mocks.closeTerminal.mock.calls.map((call) => call[4])).toEqual([!asks])
    // A cancelled prompt keeps the terminal and removes the chat opened for it.
    expect(creates()).toHaveLength(asks ? 0 : 1)
    expect(tabs()).toHaveLength(asks ? 0 : 1)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('shows a chat already opening this conversation and keeps the terminal', async () => {
    mocks.call.mockImplementationOnce(() => new Promise(() => undefined))
    const other = startStructuredAgentLaunch('wt-1', 'claude', {
      requestId: 'other-resume',
      resumeFrom: { providerSessionId: SOURCE.providerSessionId }
    })
    await vi.waitFor(() => expect(creates()).toHaveLength(1))
    await runCliChatResume(SOURCE)
    await main?.settle()
    expect(mocks.closeTerminal).not.toHaveBeenCalled()
    expect(tabs().map((tab) => tab.entityId)).toEqual([other.sessionId])
    expect(creates()).toHaveLength(1)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('stops counting preparation time once the close waits on the user', async () => {
    vi.useFakeTimers()
    const consent = deferred<boolean>()
    mocks.closeTerminal.mockImplementation(async (_source, _current, hooks, signal) => {
      hooks.prepared()
      const closed = await consent.promise
      expect(signal.aborted).toBe(false)
      hooks.closing()
      return closed
    })
    const running = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.closeTerminal).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(60_000)
    consent.resolve(true)
    vi.useRealTimers()
    await running
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  // The pane's conversation changes while the close dialog is open, then the user confirms Close.
  it.each([false, true])('a vetoed confirmed close, newer continuation: %s', async (successor) => {
    const next = { ...SOURCE, agent: 'codex' as const }
    const held = deferred<boolean>()
    let refuse = () => {}
    mocks.closeTerminal.mockImplementationOnce(async (_source, _current, hooks, signal) => {
      refuse = hooks.refused
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(false)))
    })
    const first = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.closeTerminal).toHaveBeenCalledOnce())
    mocks.source = next
    useAppStore.setState({})
    await first
    if (successor) {
      mocks.closeTerminal.mockImplementationOnce(() => held.promise)
      void runCliChatResume(next)
      await vi.waitFor(() => expect(mocks.closeTerminal).toHaveBeenCalledTimes(2))
    }
    refuse()
    expect(mocks.toast).toHaveBeenCalledTimes(successor ? 0 : 1)
    held.resolve(false)
    // The terminal stayed, so the chat opened for it went with nothing created.
    expect(creates()).toEqual([])
  })

  // Only an open chat is answered before the close; the host's create judges terminals.
  it.each([
    { name: 'another terminal', row: row('other:leaf'), closes: true },
    {
      name: 'an open chat',
      row: row('chat-tab:leaf', { tabId: 'chat-tab', terminalResumeEligible: false }),
      closes: false
    }
  ])('before the close: $name', async ({ row: holder, closes }) => {
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: { ...state.agentStatusByPaneKey, [holder.paneKey]: holder }
    }))
    useAppStore.getState().createUnifiedTab('wt-1', 'agent-session', {
      id: 'chat-tab',
      entityId: 'owner-chat'
    })
    await runCliChatResume(SOURCE, true)
    expect(mocks.closeTerminal).toHaveBeenCalledTimes(closes ? 1 : 0)
    expect(mocks.call).toHaveBeenCalledTimes(closes ? 1 : 0)
    expect(mocks.activate.mock.calls).toEqual(
      closes
        ? []
        : [
            [
              { structuredSession: { sessionId: 'owner-chat', workspaceId: 'wt-1' } },
              undefined,
              { kind: 'local' }
            ]
          ]
    )
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})

// The same host refusal on an older host (terminal kept, CLI source sent, said in a toast) and a capable
// one (closed first, said in the chat that took its place).
// A capable host whose pane agent already quit keeps the terminal, exactly as an older host does.
// Only the host's process read decides: a CLI has no status row before its first hook.
describe.each([
  { host: 'an older host', closeCapable: false, live: false },
  { host: 'a capable host, agent already quit', closeCapable: true, live: false },
  { host: 'a capable host, agent running', closeCapable: true, live: true },
  { host: 'a capable host, agent before its first hook', closeCapable: true, live: true }
])('the same create outcome on $host', ({ host, closeCapable, live }) => {
  const closes = closeCapable && live
  beforeEach(() => {
    mocks.closeCapability.mockResolvedValue(closeCapable)
    if (host.endsWith('agent running')) {
      showAgentInSource()
    }
    if (closeCapable) {
      mocks.probe.mockImplementation(async ([ptyId]: string[]) => [
        { ptyId, verdict: live ? 'live' : 'exited', timedOut: false, remote: false }
      ])
    }
  })
  const owner = { sessionId: 'owner-chat', workspaceId: 'owner-workspace' }
  it.each([
    { name: 'it opens', refusal: null, older: null, opens: true },
    { name: 'a chat owns it', refusal: held(owner), older: null, activates: true },
    {
      name: 'a terminal holds it',
      refusal: held(),
      older:
        'Claude is running this conversation in another terminal. Quit it there or close that terminal, then try again.'
    },
    {
      name: 'nothing saved yet',
      refusal: refuse('transcriptNotFound'),
      older: "Claude hasn't saved this conversation yet. Try again after it replies."
    },
    {
      name: 'saved but unreadable',
      refusal: refuse('transcriptUnreadable'),
      older: /couldn't open.*history/i
    },
    {
      // Not an admission refusal, so the launch keeps its recovery tab on either path.
      name: 'the agent says a terminal still has it',
      refusal: {
        code: 'agent_session_operation_invalid',
        message: 'private',
        details: { reason: 'conversationOpenInTerminal' },
        createAttemptRefusedBeforeCommit: true
      },
      older: null,
      recoveryTab: true
    }
  ])('$name', async ({ refusal, older, activates, recoveryTab, opens }) => {
    if (refusal) {
      mocks.call.mockResolvedValue({ ok: false, refusal })
    }
    await runCliChatResume(SOURCE, true)
    expect(mocks.call.mock.calls[0][2].resumeFrom).toEqual({
      providerSessionId: SOURCE.providerSessionId,
      ...(closes ? {} : { cliSource: { workspaceId: 'wt-1', paneKey: 'tab-1:leaf' } })
    })
    expect(mocks.closeTerminal).toHaveBeenCalledTimes(closes ? 1 : 0)
    expect(mocks.activate).toHaveBeenCalledTimes(activates ? 1 : 0)
    const toast = closes ? null : older
    expect(mocks.toast.mock.calls.map(([text]) => text)).toEqual(
      toast === null ? [] : [toast instanceof RegExp ? expect.stringMatching(toast) : toast]
    )
    const saysInChat = closes && !!refusal && !activates && !recoveryTab
    expect(tabs()).toHaveLength(recoveryTab || opens || saysInChat ? 1 : 0)
    expect(!!chatFailure()).toBe(saysInChat)
  })
})
