import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { readPendingWebRuntimeTerminalCreates } from './pending-web-runtime-terminal-creates'
import {
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

type RuntimeRequest = { method: string; params?: Record<string, unknown> }
type DiagnosticsListener = (event: {
  environmentId: string
  diagnostics: { state: string }
}) => void

const LOST_REPLY = {
  id: 'lost',
  ok: false,
  error: {
    code: 'runtime_timeout',
    message: 'Timed out waiting for the remote Orca runtime to respond.'
  }
}

function statusResponse(capabilities: string[]): unknown {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'runtime-1',
      graphStatus: 'ready',
      runtimeProtocolVersion: 3,
      minCompatibleRuntimeClientVersion: 2,
      capabilities
    }
  }
}

function stubRuntime(
  capabilities: string[],
  create: (request: RuntimeRequest, attempt: number) => unknown
): { calls: RuntimeRequest[]; emitControlState: (state: string) => void } {
  const calls: RuntimeRequest[] = []
  const listeners = new Set<DiagnosticsListener>()
  let attempts = 0
  const runtimeCall = vi.fn(async (request: RuntimeRequest) => {
    calls.push(request)
    if (request.method === 'status.get') {
      return statusResponse(capabilities)
    }
    if (
      request.method === 'session.tabs.createTerminal' ||
      request.method === 'terminal.createAgentSession'
    ) {
      attempts += 1
      return create(request, attempts)
    }
    return { id: 'list', ok: true, result: makeSnapshot() }
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: runtimeCall,
        onSharedControlDiagnostics: (listener: DiagnosticsListener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
  return {
    calls,
    emitControlState: (state) => {
      for (const listener of listeners) {
        listener({ environmentId: ENVIRONMENT_ID, diagnostics: { state } })
      }
    }
  }
}

function createRequests(calls: RuntimeRequest[], method: string): RuntimeRequest[] {
  return calls.filter((request) => request.method === method)
}

const CREATED_TAB = {
  id: 'created',
  ok: true,
  result: { tab: { id: 'host-tab-2' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
}

describe('createWebRuntimeSessionTerminal when the reply is lost', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('replays a plain create under the same mutation id and settles on the host answer', async () => {
    const { calls } = stubRuntime([TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY], (_, attempt) =>
      attempt === 1 ? LOST_REPLY : CREATED_TAB
    )

    await expect(
      createWebRuntimeSessionTerminal({ worktreeId: WORKTREE_ID, activate: true })
    ).resolves.toEqual({ status: 'created' })

    const creates = createRequests(calls, 'session.tabs.createTerminal')
    expect(creates).toHaveLength(2)
    expect(creates[0].params?.clientMutationId).toEqual(expect.any(String))
    expect(creates[1].params?.clientMutationId).toBe(creates[0].params?.clientMutationId)
  })

  it('replays a plain create again once the connection comes back', async () => {
    const runtime = stubRuntime([TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY], (_, attempt) => {
      if (attempt === 2) {
        // The immediate replay meets a network that is still down; the host then comes back.
        queueMicrotask(() => {
          runtime.emitControlState('awaiting_ready')
          runtime.emitControlState('ready')
        })
      }
      return attempt < 3 ? LOST_REPLY : CREATED_TAB
    })

    await expect(
      createWebRuntimeSessionTerminal({ worktreeId: WORKTREE_ID, activate: true })
    ).resolves.toEqual({ status: 'created' })
    const creates = createRequests(runtime.calls, 'session.tabs.createTerminal')
    expect(creates).toHaveLength(3)
    expect(new Set(creates.map((request) => request.params?.clientMutationId)).size).toBe(1)
  })

  it('reports an unconfirmed create, not a failure, when the host cannot dedupe a replay', async () => {
    const { calls } = stubRuntime([], () => LOST_REPLY)

    await expect(
      createWebRuntimeSessionTerminal({ worktreeId: WORKTREE_ID, activate: true })
    ).resolves.toEqual({ status: 'unconfirmed', message: LOST_REPLY.error.message })

    expect(createRequests(calls, 'session.tabs.createTerminal')).toHaveLength(1)
    // The host may have made it, so the user stays on the workspace they created it in.
    expect(mocks.setActiveWorktree).toHaveBeenCalledTimes(1)
  })

  it('still fails, without a replay, when the host answered with an error', async () => {
    const { calls } = stubRuntime([TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY], () => ({
      id: 'rejected',
      ok: false,
      error: { code: 'invalid_argument', message: 'Unknown worktree' }
    }))

    await expect(
      createWebRuntimeSessionTerminal({ worktreeId: WORKTREE_ID, activate: true })
    ).resolves.toEqual({ status: 'failed', message: 'Unknown worktree' })
    expect(createRequests(calls, 'session.tabs.createTerminal')).toHaveLength(1)
  })

  it('replays an agent create under the same operation id', async () => {
    const { calls } = stubRuntime(
      [AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY],
      (_, attempt) =>
        attempt === 1
          ? LOST_REPLY
          : {
              id: 'agent',
              ok: true,
              result: {
                terminal: { tabId: 'host-tab-2', paneKey: 'host-tab-2:leaf-2' },
                disposition: 'replayed'
              }
            }
    )

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        agentSessionKind: 'fresh',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    const creates = createRequests(calls, 'terminal.createAgentSession')
    expect(creates).toHaveLength(2)
    expect(creates[1].params?.clientOperationId).toBe(creates[0].params?.clientOperationId)
  })

  it('shows a pending tab for exactly as long as the create is in flight', async () => {
    let answer: ((response: unknown) => void) | null = null
    stubRuntime([], () => new Promise((resolve) => (answer = resolve)))

    const created = createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      targetGroupId: 'group-left',
      activate: true
    })
    await vi.waitFor(() => expect(answer).not.toBeNull())
    expect(readPendingWebRuntimeTerminalCreates()).toEqual([
      expect.objectContaining({ worktreeId: WORKTREE_ID, groupId: 'group-left', label: 'Claude' })
    ])

    answer!(CREATED_TAB)
    await expect(created).resolves.toEqual({ status: 'created' })
    expect(readPendingWebRuntimeTerminalCreates()).toEqual([])
  })
})
