import { expect, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { stopStructuredLaunchSlotTracking } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { resetWebSessionFocusIntentForTests } from '@/runtime/web-session-focus-intent'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentSessionCreateParams } from '../../../../shared/agent-session/structured-agent-session-create'
import type { CliChatResumeSource } from './cli-chat-resume-source'

export type CliChatResumeRunMocks = {
  source: CliChatResumeSource | null
  frameDrawn: boolean
  sourceCapability: Mock
  closeCapability: Mock
  closeTerminal: Mock
  probe: Mock
  createCapability: Mock
  call: Mock
  toast: Mock
  activate: Mock
}

export const SOURCE: CliChatResumeSource = {
  tabId: 'tab-1',
  workspaceId: 'wt-1',
  paneKey: 'tab-1:leaf',
  agent: 'claude',
  providerSessionId: 'provider-1',
  executionHostId: 'local'
}
export const tabs = () => useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
export function held(owner?: { sessionId: string; workspaceId: string }): AgentSessionWireRefusal {
  return {
    code: 'agent_session_conflict',
    message: 'private host evidence',
    details: { reason: 'conversationHeldElsewhere', ...(owner ? { owner } : {}) },
    createAttemptRefusedBeforeCommit: true
  }
}
export function refuse(
  reason: 'transcriptNotFound' | 'transcriptUnreadable'
): AgentSessionWireRefusal {
  return {
    code: 'agent_session_identity_required',
    message: 'private host error',
    details: { reason },
    createAttemptRefusedBeforeCommit: true
  }
}

export const row = (paneKey: string, extra: Record<string, unknown> = {}) => ({
  agentType: 'claude' as const,
  paneKey,
  worktreeId: 'wt-1',
  providerSession: { key: 'session_id' as const, id: SOURCE.providerSessionId },
  state: 'done' as const,
  prompt: '',
  updatedAt: Date.now(),
  stateStartedAt: Date.now(),
  stateHistory: [],
  ...extra
})
export const showAgentInSource = () =>
  useAppStore.setState({
    agentStatusByPaneKey: { [SOURCE.paneKey]: row(SOURCE.paneKey, { tabId: 'tab-1' }) }
  })

/** Every test starts with one terminal pane whose shell still runs its agent, on a host that can't close it. */
export function resetCliChatResumeRun(mocks: CliChatResumeRunMocks): void {
  vi.clearAllMocks()
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  stopStructuredLaunchSlotTracking()
  localStorage.clear()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetWebSessionFocusIntentForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf' },
        activeLeafId: 'leaf',
        expandedLeafId: null,
        ptyIdsByLeafId: { leaf: 'pty-1' }
      }
    }
  })
  mocks.source = SOURCE
  mocks.frameDrawn = false
  mocks.closeCapability.mockResolvedValue(false)
  mocks.closeTerminal.mockImplementation(async (_source, _current, hooks) => {
    hooks.prepared()
    hooks.closing()
    return true
  })
  mocks.probe.mockImplementation(async ([ptyId]: string[]) => [
    { ptyId, verdict: 'live', timedOut: false, remote: false }
  ])
  mocks.sourceCapability.mockResolvedValue(true)
  mocks.createCapability.mockResolvedValue(true)
  mocks.call.mockImplementation(
    async (_target, method, params: StructuredAgentSessionCreateParams) => {
      // A pending chat closed before its create tells the host as any closed chat does.
      if (method === 'agentSession.close') {
        return { ok: true }
      }
      expect(method).toBe('agentSession.create')
      return { ok: true, value: { sessionId: params.envelope.sessionId, fence: 1 } }
    }
  )
}
