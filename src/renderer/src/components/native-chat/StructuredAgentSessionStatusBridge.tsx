import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import {
  hasPersistedStructuredAgentSessionTurn,
  projectStructuredAgentSessionStatus,
  structuredAgentSessionPaneKey
} from '../../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { Tab } from '../../../../shared/tab-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionReadObservation } from './use-structured-agent-session-read'

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

function latestPrompt(state: StructuredAgentSessionState): string {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const body = state.items[index]?.body
    if (body?.kind === 'message' && body.role === 'user') {
      return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    }
  }
  return ''
}

function projectStatus(
  tab: StructuredTab,
  state: StructuredAgentSessionState,
  providerSession: AgentProviderSessionMetadata | undefined
): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = useAppStore.getState()
  if (!hasPersistedStructuredAgentSessionTurn(state.items)) {
    if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const projection = projectStructuredAgentSessionStatus(state.items)
  const desired = {
    state: projection === 'working' ? 'working' : projection === 'attention' ? 'blocked' : 'done',
    prompt: latestPrompt(state),
    agentType: tab.agentSessionAgent,
    sessionBoundary: projection === 'idle'
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
    agentProviderSessionsEqual(tab.agentSessionAgent, current.providerSession, providerSession)
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
      ...(providerSession ? { providerSession } : {}),
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
  const { providerSession, state } = useStructuredAgentSessionReadObservation({
    sessionId: tab.entityId,
    target
  })
  useEffect(() => {
    projectStatus(tab, state, providerSession)
  }, [providerSession, state, tab])
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
