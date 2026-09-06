import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
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

/** The host's projected status for one session, live while the caller is mounted. */
function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget
): AgentSessionStatusSummary | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId) ?? null,
    () => null
  )
}

function projectStatus(tab: StructuredTab, summary: AgentSessionStatusSummary | null): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = useAppStore.getState()
  // No persisted turn yet (or nothing known): the row shows no agent status at all.
  if (!summary?.status) {
    if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const desired = {
    state:
      summary.status === 'working'
        ? 'working'
        : summary.status === 'attention'
          ? 'blocked'
          : 'done',
    prompt: summary.latestPrompt,
    agentType: tab.agentSessionAgent,
    sessionBoundary: summary.status === 'idle'
  } as const
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === desired.state &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    current.sessionBoundary === desired.sessionBoundary &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId &&
    current.terminalResumeEligible === false &&
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
    undefined,
    { tabId: tab.id, worktreeId: tab.worktreeId },
    {
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      terminalResumeEligible: false
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
  const summary = useStructuredAgentSessionStatusSummary(tab.entityId, target)
  useEffect(() => {
    projectStatus(tab, summary)
  }, [summary, tab])
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
