import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => {
  const state: {
    settings: Record<string, unknown>
    activeGroupIdByWorktree: Record<string, string>
  } = { settings: {}, activeGroupIdByWorktree: {} }
  return {
    callRuntimeRpc: vi.fn(),
    runtimeEnvironmentSupportsCapability: vi.fn(),
    ensureLocalRuntimeCapabilities: vi.fn(),
    getRuntimeEnvironmentIdForWorktree: vi.fn(),
    isWebRuntimeSessionActive: vi.fn(),
    toastError: vi.fn(),
    toastWarning: vi.fn(),
    showNotDelivered: vi.fn(),
    showStartedElsewhere: vi.fn(),
    workspaceInView: vi.fn(),
    settleTerminalPlacement: vi.fn(),
    refreshSessionTabs: vi.fn(),
    state
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/runtime/web-runtime-terminal-placement-settlement', () => ({
  settleWebRuntimeTerminalPlacement: mocks.settleTerminalPlacement
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refreshSessionTabs
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.ensureLocalRuntimeCapabilities
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: mocks.callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: mocks.runtimeEnvironmentSupportsCapability
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, warning: mocks.toastWarning } }))
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchPromptNotDeliveredNotice: mocks.showNotDelivered
}))
vi.mock('@/lib/agent-launch-started-elsewhere-notice', () => ({
  showAgentLaunchStartedElsewhereNotice: mocks.showStartedElsewhere
}))
vi.mock('@/lib/workspace-terminal-view', () => ({
  isWorkspaceInTerminalView: mocks.workspaceInView
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  type AgentLaunchTabReservation,
  agentLaunchReservedGroupIds,
  agentLaunchTabReservationCountForTests,
  claimAgentLaunchTabReservation
} from './agent-launch-tab-reservations'
import {
  launchSourceControlAgent,
  settleSourceControlAgentLaunch,
  type SourceControlAgentLaunchArgs
} from './source-control-agent-launch'
import {
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
} from '../../../shared/agent-launch-runtime-capability'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'
import {
  peekWebSessionTerminalPlacementGroup,
  resetWebSessionTerminalPlacementsForTests
} from '@/runtime/web-session-terminal-placement'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'

const HOST_CAPABILITIES = [
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
]
const PROMPT = 'Fix the failing checks.\nLog tail:\nerror TS2322'
const ARGS: SourceControlAgentLaunchArgs = {
  agent: 'claude',
  worktreeId: 'wt-1',
  prompt: `  ${PROMPT}  `,
  agentArgs: '--model opus',
  launchSource: 'conflict_resolution'
}

function launchResult(prompt: Record<string, unknown> | undefined, extra = {}) {
  return {
    outcome: { kind: 'terminal', handle: 'term_1', paneKey: 'x:y' },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
    ...(prompt ? { prompt } : {}),
    ...extra
  }
}

function rpcRefusal(code: string, message = code): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: 'r', ok: false, error: { code, message } })
}

function sentParams(call = 0): Record<string, unknown> {
  return mocks.callRuntimeRpc.mock.calls[call]?.[2]
}

beforeEach(() => {
  vi.resetAllMocks()
  resetWebSessionFocusIntentForTests()
  resetWebSessionTerminalPlacementsForTests()
  mocks.state = { settings: {}, activeGroupIdByWorktree: { 'wt-1': 'group-2' } }
  mocks.settleTerminalPlacement.mockResolvedValue(undefined)
  mocks.refreshSessionTabs.mockResolvedValue(undefined)
  mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
  mocks.workspaceInView.mockReturnValue(true)
  mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(HOST_CAPABILITIES)
  mocks.callRuntimeRpc.mockResolvedValue(
    launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
  )
})

describe('launching a source-control button’s agent through the host', () => {
  it('asks the local host for exactly this launch, replay-protected', async () => {
    await launchSourceControlAgent(ARGS)

    const [target, method, params, options] = mocks.callRuntimeRpc.mock.calls[0]!
    expect(target).toEqual({ kind: 'local' })
    expect(method).toBe('agent.launchReplay')
    expect(params).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-1' },
      prompt: { text: PROMPT, delivery: 'submit' },
      agentArgs: '--model opus',
      launchSource: 'conflict_resolution'
    })
    expect(params.operationId).toMatch(/^\d+-[0-9a-f]{32}$/)
    expect(parsePaneKey(params.paneKey)).not.toBeNull()
    expect(params.sessionId).toMatch(/^claude_/)
    expect(options).toMatchObject({ timeoutMs: 90_000 })
  })

  it('sends no session id for an agent with no chat session, and passes null arguments through', async () => {
    await launchSourceControlAgent({ ...ARGS, agent: 'aider', agentArgs: null })

    expect(sentParams()).not.toHaveProperty('sessionId')
    expect(sentParams()).toHaveProperty('agentArgs', null)
  })

  it('leaves the settings arguments to the host when the button carries none', async () => {
    await launchSourceControlAgent({ ...ARGS, agentArgs: undefined })

    expect(sentParams()).not.toHaveProperty('agentArgs')
  })

  // Why: each button once passed its own group id, and some passed none or a workspace id.
  it('reserves the workspace’s focused group under the tab it asks for, so the reveal lands it there', async () => {
    let placement: AgentLaunchTabReservation | null = null
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      placement =
        claimAgentLaunchTabReservation(parsePaneKey(params.paneKey)!.tabId, 'wt-1')?.reservation ??
        null
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent(ARGS)

    expect(placement).toMatchObject({ worktreeId: 'wt-1', groupId: 'group-2' })
  })

  // Why: a chat the host starts arrives through the tab mirror under its session tab, not the pane's.
  it('reserves the same group under the chat’s tab, so a chat the host starts lands there too', async () => {
    let chatPlacement: AgentLaunchTabReservation | null = null
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      chatPlacement =
        claimAgentLaunchTabReservation(`agent-session:${String(params.sessionId)}`, 'wt-1')
          ?.reservation ?? null
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent(ARGS)

    expect(chatPlacement).toMatchObject({ worktreeId: 'wt-1', groupId: 'group-2' })
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('sends the view mode the button would have opened the tab in, so the host reveals it that way', async () => {
    mocks.state = {
      ...mocks.state,
      settings: { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }
    }

    await launchSourceControlAgent(ARGS)

    expect(sentParams()).toHaveProperty('viewMode', 'chat')
  })

  it('leaves the view mode out locally when the button would open a terminal', async () => {
    await launchSourceControlAgent(ARGS)

    expect(sentParams()).not.toHaveProperty('viewMode')
  })

  it('reports the surface accepted at the reveal, before the prompt’s delivery settles', async () => {
    const onLaunchAccepted = vi.fn()
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      claimAgentLaunchTabReservation(
        parsePaneKey(params.paneKey)!.tabId,
        'wt-1'
      )?.reservation.onRevealed?.({ tabId: 'tab', leafId: 'leaf', inView: true })
      expect(onLaunchAccepted).toHaveBeenCalledOnce()
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent({ ...ARGS, onLaunchAccepted })

    expect(onLaunchAccepted).toHaveBeenCalledOnce()
    expect(mocks.showStartedElsewhere).not.toHaveBeenCalled()
  })

  it('offers the way to a terminal that appeared after the user left its workspace, once', async () => {
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      claimAgentLaunchTabReservation(
        parsePaneKey(params.paneKey)!.tabId,
        'wt-1'
      )?.reservation.onRevealed?.({ tabId: 'tab-a', leafId: 'leaf-a', inView: false })
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    // Still away at the reply; the reveal already said so, so the reply adds nothing.
    mocks.workspaceInView.mockReturnValue(false)

    await launchSourceControlAgent(ARGS)

    expect(mocks.showStartedElsewhere).toHaveBeenCalledOnce()
    expect(mocks.showStartedElsewhere).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: 'wt-1',
      tab: { tabId: 'tab-a', leafId: 'leaf-a' }
    })
  })

  it('offers the way to the workspace when a launch no reveal reported lands after the user left', async () => {
    mocks.workspaceInView.mockReturnValue(false)

    await launchSourceControlAgent(ARGS)

    expect(mocks.workspaceInView).toHaveBeenCalledWith('wt-1')
    expect(mocks.showStartedElsewhere).toHaveBeenCalledWith({ agent: 'claude', worktreeId: 'wt-1' })
  })

  it('says nothing extra for a launch whose user stayed, or that did not start', async () => {
    await launchSourceControlAgent(ARGS)
    mocks.workspaceInView.mockReturnValue(false)
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('invalid_argument'))
    await launchSourceControlAgent(ARGS)

    expect(mocks.showStartedElsewhere).not.toHaveBeenCalled()
  })

  it('reports it accepted on the reply when no reveal read the reservation, as for a chat', async () => {
    const onLaunchAccepted = vi.fn()

    await launchSourceControlAgent({ ...ARGS, onLaunchAccepted })

    expect(onLaunchAccepted).toHaveBeenCalledOnce()
  })

  it.each([
    ['a reply', () => launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })],
    [
      'a refusal',
      () => {
        throw rpcRefusal('invalid_argument')
      }
    ],
    [
      'a lost reply every time',
      () => {
        throw new Error('socket closed')
      }
    ]
  ])('releases the reservation after %s', async (_label, answer) => {
    mocks.callRuntimeRpc.mockImplementation(async () => answer())

    await launchSourceControlAgent(ARGS)

    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('asks the tab mirror to focus the chat the host starts, as a button-started chat always was', async () => {
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => ({
      ...launchResult({ delivery: 'submit', outcome: 'journaled', messageId: 'm1' }),
      outcome: { kind: 'structured', sessionId: params.sessionId, handle: 'chat_1' }
    }))

    await launchSourceControlAgent(ARGS)

    expect(
      peekWebSessionFocusIntent({ environmentId: LOCAL_STRUCTURED_SESSION_OWNER }, 'wt-1')
    ).toMatchObject({
      hostTabId: `agent-session:${String(sentParams().sessionId)}`
    })
  })

  it('withdraws the chat focus request when the host starts a terminal instead', async () => {
    await launchSourceControlAgent(ARGS)

    expect(
      peekWebSessionFocusIntent({ environmentId: LOCAL_STRUCTURED_SESSION_OWNER }, 'wt-1')
    ).toBeNull()
  })

  it('replays a lost reply under the same operation, never as a new launch', async () => {
    mocks.callRuntimeRpc
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' }))

    const result = await launchSourceControlAgent(ARGS)

    expect(result).toEqual({ kind: 'launched', promptDelivered: true })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(sentParams(1)).toEqual(sentParams(0))
  })

  it('stops replaying after three sends and says the launch is unconfirmed', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('socket closed'))

    const result = await launchSourceControlAgent(ARGS)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ kind: 'unknown' })
  })

  it.each(['runtime_timeout', 'remote_runtime_unavailable'])(
    'replays a paired host’s %s reply, which does not prove the launch never ran',
    async (code) => {
      mocks.callRuntimeRpc
        .mockRejectedValueOnce(rpcRefusal(code, 'Timed out waiting for the remote Orca runtime'))
        .mockResolvedValueOnce(launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' }))

      const result = await launchSourceControlAgent(ARGS)

      expect(result).toEqual({ kind: 'launched', promptDelivered: true })
      expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2)
      expect(sentParams(1)).toEqual(sentParams(0))
    }
  )

  it('calls a paired host that keeps timing out unconfirmed, not failed', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('runtime_timeout'))

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unknown' })
  })

  it('reports an unreachable paired host as failed instead of throwing past the caller', async () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.runtimeEnvironmentSupportsCapability.mockRejectedValue(
      new Error('Could not connect to the remote Orca runtime.')
    )

    await expect(launchSourceControlAgent(ARGS)).resolves.toEqual({
      kind: 'failed',
      message: 'Could not connect to the remote Orca runtime.'
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('treats a host that refuses the method on the first send as unsupported', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('method_not_found'))

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unsupported' })
  })

  it('treats the same refusal after a replay as unconfirmed, since the first send may have run', async () => {
    mocks.callRuntimeRpc
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(rpcRefusal('method_not_found'))

    expect((await launchSourceControlAgent(ARGS)).kind).toBe('unknown')
  })

  // Why: after a replay, the pane or chat that holds the reservation may be this launch's own.
  it('fails a taken reservation on the first send, but calls it unconfirmed after a replay', async () => {
    mocks.callRuntimeRpc.mockRejectedValueOnce(rpcRefusal('agent_launch_pane_already_live'))
    expect((await launchSourceControlAgent(ARGS)).kind).toBe('failed')

    mocks.callRuntimeRpc
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(rpcRefusal('agent_launch_session_already_exists'))
    expect((await launchSourceControlAgent(ARGS)).kind).toBe('unknown')
  })

  it('treats an operation the host no longer knows as unconfirmed', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('agent_session_operation_unknown'))

    expect((await launchSourceControlAgent(ARGS)).kind).toBe('unknown')
  })

  it('reports any other refusal as failed, with the host’s words', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('invalid_argument', 'Agent is disabled'))

    expect(await launchSourceControlAgent(ARGS)).toEqual({
      kind: 'failed',
      message: 'Agent is disabled'
    })
  })

  it('reports a prompt the host kept as not delivered, with the launch still started', async () => {
    mocks.callRuntimeRpc.mockResolvedValue(
      launchResult({ delivery: 'submit', outcome: 'not-delivered' }, { warning: 'Reveal failed.' })
    )

    expect(await launchSourceControlAgent(ARGS)).toEqual({
      kind: 'launched',
      promptDelivered: false,
      warning: 'Reveal failed.'
    })
  })

  it('under-claims a prompted launch whose reply carries no prompt receipt', async () => {
    mocks.callRuntimeRpc.mockResolvedValue(launchResult(undefined))

    expect(await launchSourceControlAgent(ARGS)).toEqual({
      kind: 'launched',
      promptDelivered: false
    })
  })

  it('stays on the older path while the local host has not answered its capability probe', async () => {
    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(null)

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unsupported' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('declines a paired host that would fold a long prompt into the typed line', async () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.runtimeEnvironmentSupportsCapability.mockImplementation(
      async (_env, capability) => capability !== AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
    )

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unsupported' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('runs the caller’s pre-launch step only for a host that takes the launch, and honours a no', async () => {
    const beforeLaunch = vi.fn(() => false)

    expect(await launchSourceControlAgent({ ...ARGS, beforeLaunch })).toEqual({ kind: 'aborted' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(null)
    beforeLaunch.mockClear()
    await launchSourceControlAgent({ ...ARGS, beforeLaunch })
    expect(beforeLaunch).not.toHaveBeenCalled()
  })

  // Why: a workspace reveal reconciles tabs, which drops an empty split nothing holds.
  it('holds the focused group while the caller’s pre-launch step runs, and lets go when it says no', async () => {
    let heldDuringStep: ReadonlySet<string> = new Set()
    const beforeLaunch = vi.fn(() => {
      heldDuringStep = agentLaunchReservedGroupIds('wt-1')
      return false
    })

    await launchSourceControlAgent({ ...ARGS, beforeLaunch })

    expect([...heldDuringStep]).toEqual(['group-2'])
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('lets go of the held group when the caller’s pre-launch step throws, and sends nothing', async () => {
    const beforeLaunch = vi.fn((): boolean => {
      throw new Error('reveal failed')
    })

    const result = await launchSourceControlAgent({ ...ARGS, beforeLaunch }).catch(
      (error: unknown) => error
    )

    expect(agentLaunchTabReservationCountForTests()).toBe(0)
    expect(result).toEqual({ kind: 'failed', message: 'reveal failed' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('a launch on a paired host', () => {
  const PAIRED = { environmentId: 'env-1' }

  beforeEach(() => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
  })

  function pairedRecords() {
    const pane = parsePaneKey(String(sentParams().paneKey))!
    return {
      pane,
      focus: peekWebSessionFocusIntent(PAIRED, 'wt-1'),
      group: peekWebSessionTerminalPlacementGroup({
        ...PAIRED,
        worktreeId: 'wt-1',
        hostTabId: pane.tabId
      })
    }
  }

  it('records where the tab goes and that it takes focus before it asks, since the tab arrives before the reply', async () => {
    let beforeReply: ReturnType<typeof pairedRecords> | null = null
    mocks.callRuntimeRpc.mockImplementation(async () => {
      beforeReply = pairedRecords()
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent(ARGS)

    expect(mocks.callRuntimeRpc.mock.calls[0]?.[0]).toEqual({ kind: 'environment', ...PAIRED })
    // Omitted, a paired host would apply its own default view mode instead of this window's.
    expect(sentParams()).toHaveProperty('viewMode', 'terminal')
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
    const { pane, focus, group } = beforeReply!
    expect(focus).toMatchObject({ hostTabId: pane.tabId, leafId: pane.leafId })
    expect(group).toBe('group-2')
    expect(mocks.settleTerminalPlacement).toHaveBeenCalledWith('env-1', 'wt-1', pane.tabId, {
      groupId: 'group-2',
      activate: true
    })
  })

  it('holds the focused group under the chat’s tab too while the terminal has not appeared', async () => {
    mocks.settleTerminalPlacement.mockReturnValue(new Promise<void>(() => {}))
    let chatPlacement: AgentLaunchTabReservation | null = null
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      chatPlacement =
        claimAgentLaunchTabReservation(`agent-session:${String(params.sessionId)}`, 'wt-1')
          ?.reservation ?? null
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent(ARGS)

    expect(chatPlacement).toMatchObject({ worktreeId: 'wt-1', groupId: 'group-2' })
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  // Why: Fix checks reveals its workspace first, and that reconcile drops an empty split nothing holds.
  it('holds the focused group through the caller’s pre-launch step, and lets go once it settles', async () => {
    let heldDuringStep: ReadonlySet<string> = new Set()
    const beforeLaunch = vi.fn(() => {
      heldDuringStep = agentLaunchReservedGroupIds('wt-1')
      return true
    })

    await launchSourceControlAgent({ ...ARGS, beforeLaunch })

    expect([...heldDuringStep]).toEqual(['group-2'])
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it.each([
    [
      'refused',
      () => {
        throw rpcRefusal('invalid_argument')
      }
    ],
    [
      'unconfirmed',
      () => {
        throw new Error('socket closed')
      }
    ]
  ])('withdraws the placement and focus when the launch is %s', async (_label, answer) => {
    mocks.callRuntimeRpc.mockImplementation(async () => answer())

    await launchSourceControlAgent(ARGS)

    const { focus, group } = pairedRecords()
    expect(focus).toBeNull()
    expect(group).toBeUndefined()
  })

  it('moves focus to the chat when the host starts one instead of a terminal', async () => {
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => ({
      ...launchResult({ delivery: 'submit', outcome: 'journaled', messageId: 'm1' }),
      outcome: { kind: 'structured', sessionId: params.sessionId, handle: 'chat_1' }
    }))

    await launchSourceControlAgent(ARGS)

    const { focus, group } = pairedRecords()
    expect(focus).toMatchObject({ hostTabId: `agent-session:${String(sentParams().sessionId)}` })
    expect(group).toBeUndefined()
    // The chat's tab arrived before the reply, so its snapshot is applied again under the intent.
    expect(mocks.refreshSessionTabs).toHaveBeenCalledWith('env-1', 'wt-1', {
      acceptCurrentSnapshot: true
    })
  })
})

describe('telling the user what a hosted launch did', () => {
  it('hands over the prompt with a Copy action when the host kept it', () => {
    const settled = settleSourceControlAgentLaunch(
      { kind: 'launched', promptDelivered: false },
      { agent: 'goose', prompt: PROMPT }
    )

    expect(settled).toEqual({ started: true, promptDelivered: false, failureNotified: true })
    expect(mocks.showNotDelivered).toHaveBeenCalledWith({ agent: 'goose', prompt: PROMPT })
  })

  it('shows the host’s warning without calling the launch a failure', () => {
    const settled = settleSourceControlAgentLaunch(
      { kind: 'launched', promptDelivered: true, warning: 'Arguments were ignored.' },
      { agent: 'claude', prompt: PROMPT }
    )

    expect(settled).toEqual({ started: true, promptDelivered: true, failureNotified: false })
    expect(mocks.toastWarning).toHaveBeenCalledWith('Arguments were ignored.')
    expect(mocks.showNotDelivered).not.toHaveBeenCalled()
  })

  it('says a refused launch failed in its own words, with the host’s reason as detail', () => {
    const settled = settleSourceControlAgentLaunch(
      { kind: 'failed', message: 'Agent is disabled' },
      { agent: 'claude', prompt: PROMPT }
    )

    expect(settled).toEqual({ started: false, promptDelivered: false, failureNotified: true })
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't start the agent.", {
      description: 'Agent is disabled'
    })
  })

  it('says once that an unconfirmed launch may have started', () => {
    const settled = settleSourceControlAgentLaunch(
      { kind: 'unknown' },
      { agent: 'claude', prompt: PROMPT }
    )

    expect(settled).toEqual({ started: false, promptDelivered: false, failureNotified: true })
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't confirm the agent started. Check the workspace before trying again."
    )
  })
})
