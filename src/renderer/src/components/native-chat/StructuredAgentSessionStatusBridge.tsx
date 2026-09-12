import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type {
  AgentSessionBackgroundTask,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import {
  AGENT_STATUS_MAX_SUBAGENTS,
  agentSubagentsEqual,
  type AgentSubagentSnapshot,
  type AgentSubagentState
} from '../../../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState
} from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

type StructuredTab = Tab & { contentType: 'agent-session' }

function isStructuredTab(tab: Tab): tab is StructuredTab {
  return tab.contentType === 'agent-session' && isAgentSessionHandleProvider(tab.agentSessionAgent)
}

const structuredTabsByUnifiedTabsSnapshot = new WeakMap<
  Record<string, Tab[]>,
  readonly StructuredTab[]
>()

/** Project structured-session tabs once per immutable tab-map snapshot. */
export function getStructuredAgentSessionTabs(
  unifiedTabsByWorktree: Record<string, Tab[]>
): readonly StructuredTab[] {
  const cached = structuredTabsByUnifiedTabsSnapshot.get(unifiedTabsByWorktree)
  if (cached) {
    return cached
  }

  const tabs: StructuredTab[] = []
  for (const worktreeTabs of Object.values(unifiedTabsByWorktree)) {
    for (const tab of worktreeTabs) {
      if (isStructuredTab(tab)) {
        tabs.push(tab)
      }
    }
  }
  structuredTabsByUnifiedTabsSnapshot.set(unifiedTabsByWorktree, tabs)
  return tabs
}

const NO_SUBSCRIPTION = (): (() => void) => () => {}

/** The host's projected status for one session, live while the caller is mounted. */
function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget,
  enabled: boolean
): { summary: AgentSessionStatusSummary | null; observation: 'live' | 'unverifiable' } {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => (enabled ? feed.activate() : undefined), [feed, enabled])
  const summary = useSyncExternalStore(
    enabled ? feed.subscribe : NO_SUBSCRIPTION,
    () => (enabled ? (feed.getSnapshot().get(sessionId) ?? null) : null),
    () => null
  )
  // Gated with the summary: a disabled bridge must open no feed at all, and an
  // unsubscribed session is exactly what `unverifiable` means.
  const observation = useSyncExternalStore(
    enabled ? feed.subscribe : NO_SUBSCRIPTION,
    () => (enabled ? feed.getSessionObservation(sessionId) : ('unverifiable' as const)),
    () => 'unverifiable' as const
  )
  return { summary, observation }
}

/** Matches the wire-parse bound in `normalizeSubagentSnapshot`. */
const SUBAGENT_ID_MAX_LENGTH = 64

function subagentStateFromTask(task: AgentSessionBackgroundTask): AgentSubagentState {
  switch (task.state) {
    case 'waiting':
      return 'waiting'
    case 'blocked':
      return 'blocked'
    case 'done':
    case 'idle':
      return 'idle'
    case 'unverifiable':
      return 'unverifiable'
    // Absent state is an old host's live task; live means working here.
    case 'working':
    case 'monitoring':
    case undefined:
      return 'working'
  }
}

/** Sidebar children for a structured session: the agent-kind background tasks
 *  the host publishes, mapped to the sidebar's own subagent vocabulary rather
 *  than widening it. Kinds stay distinct — a backgrounded shell never counts
 *  as a subagent. */
function subagentSnapshotsFromTasks(
  tasks: AgentSessionBackgroundTask[] | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!tasks) {
    return undefined
  }
  const snapshots: AgentSubagentSnapshot[] = []
  for (const task of tasks) {
    const id = task.id.trim()
    if (task.kind !== 'agent' || id.length === 0 || id.length > SUBAGENT_ID_MAX_LENGTH) {
      continue
    }
    snapshots.push({
      id,
      state: subagentStateFromTask(task),
      startedAt: task.startedAt ?? 0,
      ...(task.name ? { agentType: task.name } : {}),
      ...(task.description ? { description: task.description } : {})
    })
    if (snapshots.length >= AGENT_STATUS_MAX_SUBAGENTS) {
      break
    }
  }
  return snapshots.length > 0 ? snapshots : undefined
}

function projectStatus(
  tab: StructuredTab,
  summary: AgentSessionStatusSummary | null,
  observation: 'live' | 'unverifiable'
): void {
  const paneKey = structuredAgentSessionPaneKey(tab.entityId)
  const store = useAppStore.getState()
  // No persisted turn yet (or nothing known): the row shows no agent status at all.
  if (!summary?.status) {
    if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const subagents = subagentSnapshotsFromTasks(summary.backgroundTasks)
  const desired = {
    // Shared with `worktree ps`, so the CLI and this row cannot disagree about one session.
    state: structuredAgentSessionStatusState(summary.status),
    prompt: summary.latestPrompt,
    agentType: tab.agentSessionAgent,
    // The host projects these from the journal so the row reads like a hook-reported one:
    // the running tool while a turn is live, the agent's last words once it settles.
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
    ...(summary.lastAssistantMessage ? { lastAssistantMessage: summary.lastAssistantMessage } : {}),
    ...(subagents ? { subagents, subagentObservation: observation } : {}),
    sessionBoundary: false
  } as const
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === desired.state &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    // A row keeps the last model it was told about, so only a reported one can differ.
    (summary.model === undefined || current.model === summary.model) &&
    current.toolName === summary.toolName &&
    current.toolInput === summary.toolInput &&
    current.lastAssistantMessage === summary.lastAssistantMessage &&
    agentSubagentsEqual(current.subagents, subagents) &&
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
      // No `stateStartedAt`: passing one overrode the store's own rule, which is the host's. A
      // settled row keeps its completion time, which `agentEntryCompletionAt` reads.
      evidenceObservedAt: summary.updatedAt
    },
    { tabId: tab.id, worktreeId: tab.worktreeId },
    {
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      terminalResumeEligible: false,
      ...(summary.hostExecutionOwned ? { structuredHostOwned: true as const } : {})
    }
  )
}

function StructuredAgentSessionStatusProjection({ tab }: { tab: StructuredTab }): null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  // The local host publishes its own sessions into the agent-status store, and the IPC applicator
  // is the single writer for them. A remote host writes into ITS store, which nothing mirrors down
  // (the web-session mirror carries terminal surfaces only), so this surface stays that session's
  // writer until a mirror exists — rule 3 of remote-wire-compatibility.md.
  const hostPublishesRow = target.kind === 'local'
  const { summary, observation } = useStructuredAgentSessionStatusSummary(
    tab.entityId,
    target,
    !hostPublishesRow
  )
  useEffect(() => {
    if (hostPublishesRow) {
      return
    }
    projectStatus(tab, summary, observation)
  }, [hostPublishesRow, summary, observation, tab])
  // Kept for BOTH lanes — this is the "unmount" row of the writer disposition, not a status write.
  // A projection unmounts when its tab leaves the tab map, which is a close or a host retraction;
  // the host drops its own row on `agentSession.close` (`forgetStructuredAgentSession`), but that
  // drop goes through `dropStatusEntry`, which emits no renderer clear, so nothing else would take
  // this copy out of the store.
  useEffect(
    () => () => {
      const state = useAppStore.getState()
      // Two surfaces can mirror one session (the `:history-N` id collision path), and they share
      // one pane key. Only the last surface to leave clears the row.
      const stillMirrored = getStructuredAgentSessionTabs(state.unifiedTabsByWorktree).some(
        (candidate) => candidate.entityId === tab.entityId && candidate.id !== tab.id
      )
      if (!stillMirrored) {
        state.removeAgentStatus(structuredAgentSessionPaneKey(tab.entityId))
      }
    },
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
