import {
  chatPaneKey,
  chatPaneKeySessionId,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isAgentSessionSlotTabId } from '../../../../../../shared/agent-session/view/agent-session-slot-tab-id'
import {
  isReopenedChatTabId,
  isStructuredAgentSessionHostTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import type { RuntimeMobileSessionSnapshotTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import {
  CHAT_READ_MARK_FIELDS,
  commitWebChatReadMarkCopy,
  type ChatReadMarkField,
  type ChatReadMarks
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  type PersistedUIWriteBaseline
} from '../../ui/persisted-ui-write-baseline'
import type { AppState } from '../../../types'

type LegacyIndex = Record<ChatReadMarkField, Map<string, string[]>>
type ScanChatSessions = (visit: (sessionId: string) => void) => void
type WorkspaceReceipt = {
  runtimeId: string | undefined
  affirmsChats: boolean
  tabs: WeakRef<readonly RuntimeMobileSessionSnapshotTab[]>
  chatSessionIds: ReadonlySet<string>
}
type Census = {
  environmentId: string
  runtimeId: string | undefined
  listed: Set<string>
  uncovered: Set<string>
}
type Migration = {
  legacyIndex: LegacyIndex
  candidates: Map<string, string>
  receipts: WeakMap<object, WorkspaceReceipt>
  census?: Census
  writeFailed?: true
}
type CopyState = PersistedUIWriteBaseline &
  Pick<AppState, 'persistedUIWriteBaseline' | 'unifiedTabsByWorktree'>
type CopyPatch = ReturnType<typeof commitWebChatReadMarkCopy> & {
  persistedUIWriteBaseline: PersistedUIWriteBaseline
}

let migration: Migration | undefined

export function isWebChatReadMarkCopyPending(): boolean {
  return migration !== undefined
}

const paneKeyLeaf = (key: string): string => key.slice(key.lastIndexOf(':') + 1)
const structuredTabPrefix = structuredAgentSessionTabId('')

function indexLegacyKeys(record: Record<string, number>): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const key of Object.keys(record)) {
    const separator = key.lastIndexOf(':')
    const tabId = key.slice(0, separator)
    if (
      separator < 0 ||
      (!tabId.startsWith(structuredTabPrefix) &&
        !isReopenedChatTabId(tabId) &&
        !isAgentSessionSlotTabId(tabId) &&
        !isStructuredAgentSessionHostTabId(tabId)) ||
      chatPaneKeySessionId(key) !== null
    ) {
      continue
    }
    const leaf = key.slice(separator + 1)
    const aliases = index.get(leaf)
    if (aliases) {
      aliases.push(key)
    } else {
      index.set(leaf, [key])
    }
  }
  return index
}

export function legacyWebChatReadMarkKeys(
  field: ChatReadMarkField,
  key: string
): readonly string[] | undefined {
  const aliases = migration?.legacyIndex[field].get(paneKeyLeaf(key))
  return aliases && chatPaneKeySessionId(key) !== null ? aliases : undefined
}

export function readWebChatMark(
  state: Partial<ChatReadMarks> & { chatReadMarksCopiedHere?: boolean },
  field: ChatReadMarkField,
  key: string
): number | undefined {
  const record = state[field]
  const current = record?.[key]
  if (state.chatReadMarksCopiedHere || current !== undefined || !record) {
    return current
  }
  let value: number | undefined
  for (const alias of legacyWebChatReadMarkKeys(field, key) ?? []) {
    const at = record[alias]
    if (at !== undefined && (value === undefined || at > value)) {
      value = at
    }
  }
  return value
}

function complete(
  copy: Migration,
  state: PersistedUIWriteBaseline,
  baseline: PersistedUIWriteBaseline,
  sessionIds?: () => Iterable<string>
): CopyPatch | undefined {
  const pending = diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(state), baseline)
  let result: ReturnType<typeof commitWebChatReadMarkCopy>
  try {
    result = commitWebChatReadMarkCopy(pending, baseline, sessionIds)
  } catch {
    copy.writeFailed = true
    return undefined
  }
  migration = undefined
  return { ...result, persistedUIWriteBaseline: { ...baseline, ...result } }
}

function hasLegacyKeys(copy: Migration): boolean {
  return CHAT_READ_MARK_FIELDS.some((field) => copy.legacyIndex[field].size > 0)
}

export function startWebChatReadMarkCopy(hydrated: PersistedUIWriteBaseline): CopyPatch | undefined {
  migration = undefined
  if (hydrated.chatReadMarksCopiedHere) {
    return
  }
  const copy: Migration = {
    legacyIndex: {
      activityClearedAtByPaneKey: indexLegacyKeys(hydrated.activityClearedAtByPaneKey),
      manuallyUnreadTurnsByPaneKey: indexLegacyKeys(hydrated.manuallyUnreadTurnsByPaneKey)
    },
    candidates: new Map(),
    receipts: new WeakMap()
  }
  migration = copy
  if (!hasLegacyKeys(copy)) {
    return complete(copy, hydrated, hydrated)
  }
}

function collectCandidates(
  copy: Migration,
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  previous?: WorkspaceReceipt,
  scanChatSessions?: ScanChatSessions
): ReadonlySet<string> {
  if (previous?.tabs.deref() === tabs) {
    return previous.chatSessionIds
  }
  const chatSessionIds = new Set<string>()
  const visit = (sessionId: string): void => {
    if (chatSessionIds.has(sessionId)) {
      return
    }
    chatSessionIds.add(sessionId)
    if (previous?.chatSessionIds.has(sessionId)) {
      return
    }
    const leaf = paneKeyLeaf(chatPaneKey(sessionId))
    if (CHAT_READ_MARK_FIELDS.some((field) => copy.legacyIndex[field].has(leaf))) {
      copy.candidates.set(leaf, sessionId)
    }
  }
  if (!hasLegacyKeys(copy)) {
    return chatSessionIds
  }
  if (scanChatSessions) {
    scanChatSessions(visit)
  } else {
    for (const tab of tabs) {
      if (tab.type === 'agent-session') {
        visit(tab.sessionId)
      }
    }
  }
  return chatSessionIds
}

function completeFromTabs(copy: Migration, state: CopyState): CopyPatch | undefined {
  const { persistedUIWriteBaseline: baseline } = state
  if (!baseline) {
    return
  }
  return complete(copy, state, baseline, function* () {
    yield* copy.candidates.values()
    for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session' && tab.entityId) {
          yield tab.entityId
        }
      }
    }
  })
}

export function receiveWebChatReadMarkFrame(
  state: CopyState,
  frame: {
    environmentId: string
    worktreeId: string
    runtimeId: string | undefined
    trackingRecord: object | undefined
    affirmsChats: boolean
    tabs: readonly RuntimeMobileSessionSnapshotTab[]
    censusMember?: boolean
    scanChatSessions?: ScanChatSessions
  }
): CopyPatch | undefined {
  if (state.chatReadMarksCopiedHere || !migration) {
    return
  }
  const copy = migration
  const { environmentId, worktreeId, runtimeId, trackingRecord, affirmsChats, tabs } = frame
  const census = copy.census
  const affectsCoverage =
    !frame.censusMember &&
    census?.environmentId === environmentId &&
    census.runtimeId === runtimeId &&
    census.listed.has(worktreeId)
  const wasUncovered = affectsCoverage && census.uncovered.has(worktreeId)
  // The publisher's tracking record outlives the evictable frame receipt.
  const previous = trackingRecord && copy.receipts.get(trackingRecord)
  const chatSessionIds = collectCandidates(
    copy,
    tabs,
    previous?.runtimeId === runtimeId ? previous : undefined,
    frame.scanChatSessions
  )
  if (trackingRecord) {
    copy.receipts.set(trackingRecord, {
      runtimeId,
      affirmsChats,
      tabs: new WeakRef(tabs),
      chatSessionIds
    })
  }
  if (!affectsCoverage) {
    return
  }
  if (!affirmsChats) {
    census.uncovered.add(worktreeId)
    return
  }
  if (!wasUncovered) {
    return
  }
  census.uncovered.delete(worktreeId)
  if (census.uncovered.size === 0 && !copy.writeFailed) {
    return completeFromTabs(copy, state)
  }
}

export function receiveWebChatReadMarkCensus(
  state: CopyState,
  environmentId: string,
  runtimeId: string | undefined,
  workspaces: Iterable<readonly [worktreeId: string, trackingRecord: object | undefined]>
): CopyPatch | undefined {
  if (state.chatReadMarksCopiedHere || !migration) {
    return
  }
  const copy = migration
  delete copy.writeFailed
  if (!hasLegacyKeys(copy)) {
    const baseline = state.persistedUIWriteBaseline
    return baseline ? complete(copy, state, baseline) : undefined
  }
  const listed = new Set<string>()
  const uncovered = new Set<string>()
  for (const [worktreeId, trackingRecord] of workspaces) {
    listed.add(worktreeId)
    const receipt = trackingRecord && copy.receipts.get(trackingRecord)
    if (!receipt?.affirmsChats || receipt.runtimeId !== runtimeId) {
      uncovered.add(worktreeId)
    }
  }
  copy.census = { environmentId, runtimeId, listed, uncovered }
  if (listed.size > 0 && uncovered.size === 0) {
    return completeFromTabs(copy, state)
  }
}

export function receiveWebChatReadMarkCandidates(
  state: Pick<AppState, 'chatReadMarksCopiedHere'>,
  tabs: readonly RuntimeMobileSessionSnapshotTab[]
): void {
  if (!state.chatReadMarksCopiedHere && migration) {
    collectCandidates(migration, tabs)
  }
}

export function retireWebChatReadMarkWorkspace(
  environmentId: string,
  worktreeId: string,
  runtimeId: string | undefined,
  trackingRecord: object | undefined,
  readState: () => CopyState,
  censusMember: boolean
): CopyPatch | undefined {
  const copy = migration
  if (!copy) {
    return
  }
  if (trackingRecord) {
    copy.receipts.delete(trackingRecord)
  }
  const census = copy.census
  if (census?.environmentId !== environmentId || !census.listed.delete(worktreeId)) {
    return
  }
  if (
    census.uncovered.delete(worktreeId) &&
    census.uncovered.size === 0 &&
    census.listed.size > 0 &&
    census.runtimeId === runtimeId &&
    !censusMember &&
    !copy.writeFailed
  ) {
    return completeFromTabs(copy, readState())
  }
}

export function forgetWebChatReadMarkCensus(environmentId: string): void {
  if (migration?.census?.environmentId === environmentId) {
    delete migration.census
  }
}
