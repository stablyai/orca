import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

export type AgentMetadata = {
  paneKey: string
  textParts: string[]
  snippetCandidates: string[]
  lastActivityAt: number
}

/** Latest agent activity across a tab's panes, or null if it has none. */
export function maxAgentActivityAt(metadata: readonly AgentMetadata[]): number | null {
  let max: number | null = null
  for (const entry of metadata) {
    if (entry.lastActivityAt > 0 && (max === null || entry.lastActivityAt > max)) {
      max = entry.lastActivityAt
    }
  }
  return max
}

export type WorkspaceTabAgentMetadataState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function addText(target: string[], value: string | null | undefined): void {
  const trimmed = normalizeText(value)
  if (trimmed) {
    target.push(trimmed)
  }
}

function addProviderSession(
  target: string[],
  providerSession: { key: string; id: string } | null | undefined
): void {
  if (!providerSession) {
    return
  }
  addText(target, providerSession.key)
  addText(target, providerSession.id)
}

function getPaneKeyTabId(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  return paneKey.slice(0, separator)
}

function agentRecordMatchesTab({
  paneKey,
  recordWorktreeId,
  recordTabId,
  terminalTabId,
  worktreeId
}: {
  paneKey: string
  recordWorktreeId?: string | null
  recordTabId?: string | null
  terminalTabId: string
  worktreeId: string
}): boolean {
  if (recordWorktreeId && recordWorktreeId !== worktreeId) {
    return false
  }
  if (recordTabId) {
    return recordTabId === terminalTabId
  }
  return getPaneKeyTabId(paneKey) === terminalTabId
}

function collectLiveMetadata(
  entry: AgentStatusEntry
): Pick<AgentMetadata, 'snippetCandidates' | 'textParts' | 'lastActivityAt'> {
  const textParts: string[] = []
  const snippetCandidates: string[] = []
  addText(textParts, entry.orchestration?.displayName)
  addText(snippetCandidates, entry.orchestration?.displayName)
  addText(textParts, entry.orchestration?.taskTitle)
  addText(snippetCandidates, entry.orchestration?.taskTitle)
  addText(textParts, entry.prompt)
  addText(snippetCandidates, entry.prompt)
  addText(textParts, entry.agentType)
  addText(textParts, entry.state)
  addText(textParts, entry.terminalTitle)
  addText(snippetCandidates, entry.terminalTitle)
  addProviderSession(textParts, entry.providerSession)
  for (const historyEntry of entry.stateHistory) {
    addText(textParts, historyEntry.prompt)
    addText(snippetCandidates, historyEntry.prompt)
  }
  return { textParts, snippetCandidates, lastActivityAt: entry.updatedAt }
}

function collectSleepingMetadata(
  record: SleepingAgentSessionRecord
): Pick<AgentMetadata, 'snippetCandidates' | 'textParts' | 'lastActivityAt'> {
  const textParts: string[] = []
  const snippetCandidates: string[] = []
  addText(textParts, record.prompt)
  addText(snippetCandidates, record.prompt)
  addText(textParts, record.agent)
  addText(textParts, record.state)
  addText(textParts, record.terminalTitle)
  addText(snippetCandidates, record.terminalTitle)
  addProviderSession(textParts, record.providerSession)
  return { textParts, snippetCandidates, lastActivityAt: record.updatedAt }
}

export function collectAgentMetadataForTerminal({
  terminalTabId,
  worktreeId,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey
}: WorkspaceTabAgentMetadataState & {
  terminalTabId: string
  worktreeId: string
}): AgentMetadata[] {
  const metadataByPaneKey = new Map<string, AgentMetadata>()

  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    if (
      agentRecordMatchesTab({
        paneKey,
        recordWorktreeId: entry.worktreeId,
        recordTabId: entry.tabId,
        terminalTabId,
        worktreeId
      })
    ) {
      metadataByPaneKey.set(paneKey, { paneKey, ...collectLiveMetadata(entry) })
    }
  }

  for (const [paneKey, retained] of Object.entries(retainedAgentsByPaneKey)) {
    if (metadataByPaneKey.has(paneKey)) {
      continue
    }
    if (
      agentRecordMatchesTab({
        paneKey,
        recordWorktreeId: retained.worktreeId,
        recordTabId: retained.entry.tabId ?? retained.tab.id,
        terminalTabId,
        worktreeId
      })
    ) {
      const metadata = collectLiveMetadata(retained.entry)
      addText(metadata.textParts, retained.tab.title)
      addText(metadata.snippetCandidates, retained.tab.title)
      metadataByPaneKey.set(paneKey, { paneKey, ...metadata })
    }
  }

  for (const [paneKey, record] of Object.entries(sleepingAgentSessionsByPaneKey)) {
    if (metadataByPaneKey.has(paneKey)) {
      continue
    }
    if (
      agentRecordMatchesTab({
        paneKey,
        recordWorktreeId: record.worktreeId,
        recordTabId: record.tabId,
        terminalTabId,
        worktreeId
      })
    ) {
      metadataByPaneKey.set(paneKey, { paneKey, ...collectSleepingMetadata(record) })
    }
  }

  return [...metadataByPaneKey.values()]
}

type IndexedAgentEntry = {
  paneKey: string
  worktreeId: string | null | undefined
  metadata: AgentMetadata
}

export type AgentMetadataTabIndex = ReadonlyMap<string, readonly IndexedAgentEntry[]>

function pushToIndex(
  index: Map<string, IndexedAgentEntry[]>,
  tabId: string,
  entry: IndexedAgentEntry
): void {
  let bucket = index.get(tabId)
  if (!bucket) {
    bucket = []
    index.set(tabId, bucket)
  }
  bucket.push(entry)
}

export function buildAgentMetadataTabIndex(
  state: WorkspaceTabAgentMetadataState
): AgentMetadataTabIndex {
  const index = new Map<string, IndexedAgentEntry[]>()
  const seenPaneKeys = new Set<string>()

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const tabId = entry.tabId || getPaneKeyTabId(paneKey)
    if (!tabId) {
      continue
    }
    seenPaneKeys.add(paneKey)
    pushToIndex(index, tabId, {
      paneKey,
      worktreeId: entry.worktreeId,
      metadata: { paneKey, ...collectLiveMetadata(entry) }
    })
  }

  for (const [paneKey, retained] of Object.entries(state.retainedAgentsByPaneKey)) {
    if (seenPaneKeys.has(paneKey)) {
      continue
    }
    const tabId = retained.entry.tabId ?? retained.tab.id ?? getPaneKeyTabId(paneKey)
    if (!tabId) {
      continue
    }
    seenPaneKeys.add(paneKey)
    const meta = collectLiveMetadata(retained.entry)
    addText(meta.textParts, retained.tab.title)
    addText(meta.snippetCandidates, retained.tab.title)
    pushToIndex(index, tabId, {
      paneKey,
      worktreeId: retained.worktreeId,
      metadata: { paneKey, ...meta }
    })
  }

  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
    if (seenPaneKeys.has(paneKey)) {
      continue
    }
    const tabId = record.tabId || getPaneKeyTabId(paneKey)
    if (!tabId) {
      continue
    }
    pushToIndex(index, tabId, {
      paneKey,
      worktreeId: record.worktreeId,
      metadata: { paneKey, ...collectSleepingMetadata(record) }
    })
  }

  return index
}

export function collectAgentMetadataFromIndex(
  index: AgentMetadataTabIndex,
  terminalTabId: string,
  worktreeId: string
): AgentMetadata[] {
  const entries = index.get(terminalTabId)
  if (!entries) {
    return []
  }
  return entries.filter((e) => !e.worktreeId || e.worktreeId === worktreeId).map((e) => e.metadata)
}
