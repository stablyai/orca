import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import {
  agentChildWorkProjectionCandidateFromBackgroundTask,
  projectAgentChildWorkLegacySubagents
} from '../../../../shared/agent-status-child-work-projection'
import {
  continueMainAgentStatus,
  isAgentStatusHeldOpenByChildWork,
  mainAgentTurnInterrupted
} from '../../../../shared/agent-lead-status-fold'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import {
  agentChildWorkViewsEqual,
  decodeAgentChildWorkViews
} from '../../../../shared/agent-status-child-work-view-wire'
import {
  agentSubagentsEqual,
  mainAgentStatusEqual,
  type AgentSubagentSnapshot
} from '../../../../shared/agent-status-types'
import { structuredChildWorkLegacySubagents } from '../../../../shared/structured-agent-session-child-work-legacy'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import {
  structuredAgentSessionDatedMainAgent,
  structuredAgentSessionRowStateStartedAt
} from '../../../../shared/structured-agent-session-status-started-at'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'
import { useStructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch-registry'
import { useStructuredAgentSessionLaunchFailedAt } from '@/lib/structured-agent-session-launch-failed-at'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { getStructuredAgentSessionTabs, type StructuredTab } from './structured-agent-session-tabs'

// Re-exported so the bridge stays the one import site its consumers already know.
export { getStructuredAgentSessionTabs } from './structured-agent-session-tabs'

/** The host's projected status for one session, live while the caller is mounted. */
export function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget
): { summary: AgentSessionStatusSummary | null; observation: 'live' | 'unverifiable' } {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  const summary = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId) ?? null,
    () => null
  )
  const observation = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSessionObservation(sessionId),
    () => 'unverifiable' as const
  )
  return { summary, observation }
}

/** Only the host's startup phase, so a chat re-renders when that changes, not on every status. */
export function useStructuredAgentSessionHostExecutionPhase(
  sessionId: string,
  target: RuntimeClientTarget
): NonNullable<AgentSessionStatusSummary['hostExecutionPhase']> | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.hostExecutionPhase ?? null,
    () => null
  )
}

/** Whether the host says a person's Stop is still ending the work; an older host never does. */
export function useStructuredAgentSessionHostStopping(
  sessionId: string,
  target: RuntimeClientTarget
): boolean {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.stopping === true,
    () => false
  )
}

/** The host's startup phase and its word on a Stop, each re-rendering the chat only on a change. */
export function useStructuredAgentSessionHostExecution(
  sessionId: string,
  target: RuntimeClientTarget
): { phase: ReturnType<typeof useStructuredAgentSessionHostExecutionPhase>; stopping: boolean } {
  return {
    phase: useStructuredAgentSessionHostExecutionPhase(sessionId, target),
    stopping: useStructuredAgentSessionHostStopping(sessionId, target)
  }
}

/** Only the host's rewind recovery latch, so a chat re-renders when that changes, not on every status. */
export function useStructuredAgentSessionRewindBlockedReason(
  sessionId: string,
  target: RuntimeClientTarget
): NonNullable<AgentSessionStatusSummary['rewindBlockedReason']> | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.rewindBlockedReason ?? null,
    () => null
  )
}

/** The host's child records for the row, and the legacy roster readers of `subagents` keep. A host
 *  that publishes views is copied verbatim; only an older host's task list is converted here. */
function childWorkFor(summary: AgentSessionStatusSummary): {
  children?: AgentChildWorkView[]
  subagents?: AgentSubagentSnapshot[]
} {
  const children = decodeAgentChildWorkViews(summary.children)
  if (children) {
    const subagents = structuredChildWorkLegacySubagents(children, summary.agent)
    return { children, ...(subagents ? { subagents } : {}) }
  }
  const subagents = summary.backgroundTasks
    ? projectAgentChildWorkLegacySubagents(
        summary.backgroundTasks.map(agentChildWorkProjectionCandidateFromBackgroundTask)
      )
    : undefined
  return subagents ? { subagents } : {}
}

/** A start the host refused leaves it no session to publish, so the launch's own failure is the
 *  row: the same failed verdict the host publishes for a send the agent's start refused. */
function projectFailedStart(tab: StructuredTab, paneKey: string, failedAt: number): void {
  const store = useAppStore.getState()
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === 'done' &&
    agentMainAgentVerdict(current) === 'failure' &&
    current.updatedAt === failedAt &&
    current.stateStartedAt === failedAt &&
    current.agentType === tab.agentSessionAgent &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId
  ) {
    return
  }
  const { state, mainAgent } = structuredAgentSessionAgentStatus({
    status: 'idle',
    turnOutcome: 'failure'
  })
  store.setAgentStatus(
    paneKey,
    {
      state,
      mainAgent: { ...mainAgent, stateStartedAt: failedAt },
      interrupted: false,
      prompt: '',
      agentType: tab.agentSessionAgent,
      sessionBoundary: false
    },
    tab.label,
    // Dated by the failure, as a host row is by its journal: it ages the same, a restart does not
    // refresh it, and it replaces whatever newer-dated row the pane key held.
    { updatedAt: failedAt, allowOlderTimestamp: true, stateStartedAt: failedAt },
    { tabId: tab.id, worktreeId: tab.worktreeId },
    { terminalResumeEligible: false }
  )
}

function projectStatus(
  tab: StructuredTab,
  summary: AgentSessionStatusSummary | null,
  observation: 'live' | 'unverifiable',
  /** When the launch failed; null while it has not. */
  launchFailedAt: number | null
): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = useAppStore.getState()
  // No persisted turn yet (or nothing known): the row shows no agent status at all.
  if (!summary?.status) {
    if (launchFailedAt !== null) {
      projectFailedStart(tab, paneKey, launchFailedAt)
    } else if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const { children, subagents } = childWorkFor(summary)
  // Shared with `worktree ps`, so the CLI and this row cannot disagree about one session.
  const agentStatus = structuredAgentSessionAgentStatus({
    status: summary.status,
    childWork: children ?? summary.backgroundTasks,
    turnOutcome: summary.turnOutcome,
    ...(summary.stopping ? { stopping: summary.stopping } : {})
  })
  const current = store.agentStatusByPaneKey?.[paneKey]
  // Same continuity rule as the host ingest, on the main agent's own clock.
  const mainAgent = continueMainAgentStatus(
    current?.mainAgent,
    structuredAgentSessionDatedMainAgent(agentStatus.mainAgent, summary),
    summary.updatedAt
  )
  const desired = {
    state: agentStatus.state,
    ...(agentStatus.workingMode ? { workingMode: agentStatus.workingMode } : {}),
    mainAgent,
    // Derived from `mainAgent`, so the equality below needs no second check of it.
    interrupted: mainAgentTurnInterrupted(mainAgent),
    prompt: summary.latestPrompt,
    agentType: tab.agentSessionAgent,
    // The host projects these from the journal so the row reads like a hook-reported one:
    // the turn's running or latest tool while it is live, the agent's last words once it settles.
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
    ...(summary.lastAssistantMessage ? { lastAssistantMessage: summary.lastAssistantMessage } : {}),
    ...(subagents ? { subagents } : {}),
    ...(children ? { children } : {}),
    ...(subagents || children ? { subagentObservation: observation } : {}),
    sessionBoundary: false
  } as const
  if (
    current?.state === desired.state &&
    current.workingMode === desired.workingMode &&
    mainAgentStatusEqual(current.mainAgent, desired.mainAgent) &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    // A row keeps the last model it was told about, so only a reported one can differ.
    (summary.model === undefined || current.model === summary.model) &&
    current.toolName === summary.toolName &&
    current.toolInput === summary.toolInput &&
    current.lastAssistantMessage === summary.lastAssistantMessage &&
    agentSubagentsEqual(current.subagents, subagents) &&
    agentChildWorkViewsEqual(current.children, children) &&
    current.subagentObservation === desired.subagentObservation &&
    current.sessionBoundary === desired.sessionBoundary &&
    current.updatedAt === summary.updatedAt &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId &&
    current.terminalResumeEligible === false &&
    current.structuredHostOwned === summary.hostExecutionOwned &&
    agentProviderSessionsEqual(
      tab.agentSessionAgent,
      current.providerSession,
      summary.providerSession
    )
  ) {
    return
  }
  store.setAgentStatus(
    paneKey,
    desired,
    tab.label,
    {
      updatedAt: summary.updatedAt,
      // This ordered host feed can correct a legacy publication clock after upgrade.
      allowOlderTimestamp: true,
      // Same continuity key as the host ingest: monitoring and working are distinct published
      // states, so the timer beside the label must restart when the label changes.
      stateStartedAt:
        structuredAgentSessionRowStateStartedAt(desired, summary) ??
        (desired.state !== 'done' &&
        current?.state === desired.state &&
        current.workingMode === desired.workingMode
          ? current.stateStartedAt
          : summary.updatedAt),
      // Same rule as the host ingest: the journal clock stopped when the lead's turn did, so a
      // row held open by child work alone is dated by when this client saw it instead.
      evidenceObservedAt: isAgentStatusHeldOpenByChildWork(desired) ? Date.now() : summary.updatedAt
    },
    { tabId: tab.id, worktreeId: tab.worktreeId },
    {
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      terminalResumeEligible: false,
      ...(summary.hostExecutionOwned ? { structuredHostOwned: true as const } : {})
    }
  )
}

/** Reads the chat's status from the host recorded on its tab; a chat no host can be named for has
 *  none to read. */
function StructuredAgentSessionStatusProjection({
  tab
}: {
  tab: StructuredTab
}): React.JSX.Element | null {
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  return target ? <StructuredAgentSessionOwnedStatusProjection tab={tab} target={target} /> : null
}

function StructuredAgentSessionOwnedStatusProjection({
  tab,
  target
}: {
  tab: StructuredTab
  target: RuntimeClientTarget
}): null {
  const { summary, observation } = useStructuredAgentSessionStatusSummary(tab.entityId, target)
  const launchFailed =
    useStructuredAgentSessionLaunchLifecycle(tab.worktreeId, tab.entityId) === 'failed'
  const failedAt = useStructuredAgentSessionLaunchFailedAt(tab.entityId)
  // Only records saved by older builds lack the time; the tab's creation precedes any
  // acknowledgement of it, so a failure seen before then stays read.
  const launchFailedAt = launchFailed ? (failedAt ?? tab.createdAt) : null
  useEffect(() => {
    projectStatus(tab, summary, observation, launchFailedAt)
  }, [summary, observation, tab, launchFailedAt])
  const launchDirectory = summary?.launchDirectory
  useEffect(() => {
    // Why local only: a remote host's path is in its syntax, and floating chats only run locally.
    useAppStore
      .getState()
      .setStructuredSessionLaunchDirectory(
        tab.id,
        tab.entityId,
        target.kind === 'local' ? launchDirectory : undefined
      )
  }, [launchDirectory, target.kind, tab.id, tab.entityId])
  useEffect(
    () => () => useAppStore.getState().clearStructuredSessionLaunchDirectory(tab.id, tab.entityId),
    [tab.entityId, tab.id]
  )
  useEffect(
    () => () =>
      useAppStore.getState().removeAgentStatus(structuredAgentSessionPaneKey(tab.id, tab.entityId)),
    [tab.entityId, tab.id]
  )
  return null
}

export function StructuredAgentSessionStatusBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) => getStructuredAgentSessionTabs(state.unifiedTabsByWorktree))
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionStatusProjection key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
