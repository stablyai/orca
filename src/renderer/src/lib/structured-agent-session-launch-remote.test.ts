// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  createStructuredAgentSessionLaunchIntent,
  launchStructuredAgentSession,
  retryStructuredAgentSessionLaunchIntent,
  restoreStructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import {
  launchAndReconcile,
  type StructuredLaunchRecoveryState
} from './structured-agent-session-launch-recovery'
import {
  readStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from './structured-agent-session-launch-persistence'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

const original = useAppStore.getState()
const target = {
  kind: 'environment',
  environmentId: 'nexbox',
  expectedEnvironmentPairingRevision: 10
} as const

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  resetStructuredAgentLaunchPersistenceForTests()
  replaceRuntimeEnvironmentRevisions([{ id: 'nexbox', createdAt: 1, pairingRevision: 10 }])
  useAppStore.setState({
    activeWorktreeId: 'remote-worktree',
    activeWorkspaceExecutionHostId: 'runtime:nexbox'
  })
})

afterEach(() => {
  useAppStore.setState(original)
  replaceRuntimeEnvironmentRevisions([])
})

describe('paired runtime structured launch', () => {
  it('pins support, create, retry and reload to the workspace host despite a focus change', async () => {
    const intent = createStructuredAgentSessionLaunchIntent('remote-worktree', 'codex')
    expect(intent.target).toEqual(target)
    useAppStore.setState({
      activeWorktreeId: 'local-worktree',
      activeWorkspaceExecutionHostId: 'local'
    })
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
      method === 'agentSession.createSupport'
        ? { supported: true }
        : { ok: true, value: { sessionId: intent.sessionId, fence: 1 } }
    )
    await launchStructuredAgentSession(intent)
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([owner]) => owner)).toEqual([
      target,
      target
    ])
    expect(retryStructuredAgentSessionLaunchIntent(intent).target).toEqual(target)
    writeStructuredAgentLaunchRecord({
      agent: intent.agent,
      lifecycle: 'pending',
      ...intent.params.envelope,
      target: intent.target
    })
    resetStructuredAgentLaunchPersistenceForTests()
    const record = readStructuredAgentLaunchRecord(intent.sessionId)
    if (!record) {
      throw new Error('Launch record missing')
    }
    expect(record.lifecycle).toBe('visibility-unknown')
    expect(
      restoreStructuredAgentSessionLaunchIntent({ ...record, worktreeId: intent.worktreeId }).target
    ).toEqual(target)
  })

  it('recovers a lost create reply from the remote publication and history', async () => {
    const intent = createStructuredAgentSessionLaunchIntent('remote-worktree', 'codex')
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) => {
      if (method === 'agentSession.createSupport') {
        return { supported: true }
      }
      if (method === 'agentSession.history') {
        return { ok: true, page: { fence: 4 } }
      }
      throw new Error('create reply lost')
    })
    vi.mocked(callRuntimeRpc).mockResolvedValue({
      snapshots: [
        {
          worktree: intent.worktreeId,
          tabs: [{ type: 'agent-session', sessionId: intent.sessionId }]
        }
      ]
    })
    const state: StructuredLaunchRecoveryState = {
      intent,
      promise: Promise.resolve({ sessionId: intent.sessionId, fence: 4 }),
      visibilityUnknown: false,
      cancelled: false
    }
    await expect(launchAndReconcile(state)).resolves.toEqual({
      sessionId: intent.sessionId,
      fence: 4
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'session.tabs.listAll', {})
    expect(callStructuredAgentSession).toHaveBeenLastCalledWith(
      target,
      'agentSession.history',
      expect.objectContaining({ sessionId: intent.sessionId })
    )
    expect(refreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
  })

  it('keeps an unreachable host unknown without creating or reconciling locally', async () => {
    const intent = createStructuredAgentSessionLaunchIntent('remote-worktree', 'codex')
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('offline'))
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('offline'))
    const state: StructuredLaunchRecoveryState = {
      intent,
      promise: Promise.resolve({ sessionId: intent.sessionId, fence: 1 }),
      visibilityUnknown: false,
      cancelled: false
    }
    await expect(launchAndReconcile(state)).rejects.toThrow('offline')
    expect(state.visibilityUnknown).toBe(true)
    expect(
      vi.mocked(callStructuredAgentSession).mock.calls.every(([owner]) => owner === intent.target)
    ).toBe(true)
    expect(vi.mocked(callRuntimeRpc).mock.calls.every(([owner]) => owner === intent.target)).toBe(
      true
    )
    expect(refreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
  })

  it('rejects a raw SSH workspace before any create RPC', () => {
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:nexbox' })
    expect(() => createStructuredAgentSessionLaunchIntent('remote-worktree', 'codex')).toThrow(
      'paired Orca runtime'
    )
    expect(callStructuredAgentSession).not.toHaveBeenCalled()
  })
})
