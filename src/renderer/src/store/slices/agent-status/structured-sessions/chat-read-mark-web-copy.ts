import {
  chatPaneKeySessionId,
  structuredAgentSessionPaneLeaf
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { RuntimeMobileSessionSnapshotTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { SessionTabsPublicationEpochHistory } from '@/runtime/web-session-tabs-sync/state'
import {
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
import { indexLegacyKeys, paneKeyLeaf, type LegacyIndex } from './chat-read-mark-legacy-index'

const MIGRATION_WINDOW_MS = 120_000
const MAX_ACCEPTED_CENSUSES = 3

type ScanChatSessions = (visit: (sessionId: string) => void) => void

type WorkspaceReceipt = {
  runtimeId: string | undefined
  affirmsChats: boolean
}
type Census = {
  environmentId: string
  runtimeId: string | undefined
  listed: Set<string>
  uncovered: Set<string>
}
type Migration = {
  deadline: number
  acceptedCensuses: number
  candidates: Map<string, string>
  recordCandidate: (sessionId: string) => void
  receipts: WeakMap<SessionTabsPublicationEpochHistory, WorkspaceReceipt>
  census?: Census
}
type CopyState = PersistedUIWriteBaseline &
  Pick<AppState, 'persistedUIWriteBaseline' | 'unifiedTabsByWorktree'>
type CopyPatch = ReturnType<typeof commitWebChatReadMarkCopy> & {
  persistedUIWriteBaseline: PersistedUIWriteBaseline
}

// The fallback index stays available when this page stops attempting the copy.
let legacyIndex: LegacyIndex | undefined
let migration: Migration | undefined

function pendingMigration(): Migration | undefined {
  if (migration && performance.now() >= migration.deadline) {
    migration = undefined
  }
  return migration
}

export function isWebChatReadMarkCopyPending(): boolean {
  return pendingMigration() !== undefined
}

export function shouldUseWebChatReadMarkFallback(): boolean {
  return legacyIndex !== undefined
}

export function legacyWebChatReadMarkKeys(
  field: ChatReadMarkField,
  key: string
): readonly string[] | undefined {
  const aliases = legacyIndex?.get(paneKeyLeaf(key))?.[field]
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
  state: PersistedUIWriteBaseline,
  baseline: PersistedUIWriteBaseline,
  sessionIds?: () => Iterable<string>
): CopyPatch | undefined {
  const pending = diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(state), baseline)
  migration = undefined
  let result: ReturnType<typeof commitWebChatReadMarkCopy>
  try {
    result = commitWebChatReadMarkCopy(pending, baseline, sessionIds)
  } catch {
    return undefined
  }
  legacyIndex = undefined
  return { ...result, persistedUIWriteBaseline: { ...baseline, ...result } }
}

export function startWebChatReadMarkCopy(
  hydrated: PersistedUIWriteBaseline
): CopyPatch | undefined {
  migration = undefined
  legacyIndex = undefined
  if (hydrated.chatReadMarksCopiedHere) {
    return undefined
  }
  const deadline = performance.now() + MIGRATION_WINDOW_MS
  const index = indexLegacyKeys(hydrated)
  legacyIndex = index
  const candidates = new Map<string, string>()
  migration = {
    deadline,
    acceptedCensuses: 0,
    candidates,
    recordCandidate(sessionId) {
      const leaf = structuredAgentSessionPaneLeaf(sessionId)
      if (index.has(leaf) && candidates.get(leaf) !== sessionId) {
        candidates.set(leaf, sessionId)
      }
    },
    receipts: new WeakMap()
  }
  return index.size === 0 && pendingMigration() ? complete(hydrated, hydrated) : undefined
}

function collectCandidates(
  copy: Migration,
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  scanChatSessions?: ScanChatSessions
): void {
  if (scanChatSessions) {
    scanChatSessions(copy.recordCandidate)
    return
  }
  for (const tab of tabs) {
    if (tab.type === 'agent-session') {
      copy.recordCandidate(tab.sessionId)
    }
  }
}

function completeFromTabs(copy: Migration, state: CopyState): CopyPatch | undefined {
  const { persistedUIWriteBaseline: baseline } = state
  if (!baseline) {
    return undefined
  }
  return complete(state, baseline, function* () {
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
    trackingRecord: SessionTabsPublicationEpochHistory | undefined
    affirmsChats: boolean
    tabs: readonly RuntimeMobileSessionSnapshotTab[]
    censusMember?: boolean
    scanChatSessions?: ScanChatSessions
  }
): CopyPatch | undefined {
  const copy = state.chatReadMarksCopiedHere ? undefined : pendingMigration()
  if (!copy) {
    return undefined
  }
  const { environmentId, worktreeId, runtimeId, trackingRecord, affirmsChats, tabs } = frame
  const census = copy.census
  const affectsCoverage =
    !frame.censusMember &&
    census?.environmentId === environmentId &&
    census.runtimeId === runtimeId &&
    census.listed.has(worktreeId)
  const wasUncovered = affectsCoverage && census.uncovered.has(worktreeId)
  // The publisher's tracking record outlives the evictable frame receipt.
  if (trackingRecord) {
    const receipt = copy.receipts.get(trackingRecord)
    if (receipt) {
      receipt.runtimeId = runtimeId
      receipt.affirmsChats = affirmsChats
    } else {
      copy.receipts.set(trackingRecord, { runtimeId, affirmsChats })
    }
  }
  collectCandidates(copy, tabs, frame.scanChatSessions)
  if (!affectsCoverage) {
    return undefined
  }
  if (!affirmsChats) {
    census.uncovered.add(worktreeId)
    return undefined
  }
  if (!wasUncovered) {
    return undefined
  }
  census.uncovered.delete(worktreeId)
  return census.uncovered.size === 0 ? completeFromTabs(copy, state) : undefined
}

export function receiveWebChatReadMarkCensus(
  state: CopyState,
  environmentId: string,
  runtimeId: string | undefined,
  workspaces: Iterable<
    readonly [worktreeId: string, trackingRecord: SessionTabsPublicationEpochHistory | undefined]
  >
): CopyPatch | undefined {
  const copy = state.chatReadMarksCopiedHere ? undefined : pendingMigration()
  if (!copy) {
    return undefined
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
  copy.acceptedCensuses++
  const copied = listed.size > 0 && uncovered.size === 0 ? completeFromTabs(copy, state) : undefined
  if (copy.acceptedCensuses >= MAX_ACCEPTED_CENSUSES) {
    migration = undefined
  }
  return copied
}

export function receiveWebChatReadMarkCandidates(
  state: Pick<AppState, 'chatReadMarksCopiedHere'>,
  tabs: readonly RuntimeMobileSessionSnapshotTab[]
): void {
  const copy = state.chatReadMarksCopiedHere ? undefined : pendingMigration()
  if (copy) {
    collectCandidates(copy, tabs)
  }
}

export function retireWebChatReadMarkWorkspace(
  environmentId: string,
  worktreeId: string,
  runtimeId: string | undefined,
  trackingRecord: SessionTabsPublicationEpochHistory | undefined,
  readState: () => CopyState,
  censusMember: boolean
): CopyPatch | undefined {
  const copy = pendingMigration()
  if (!copy) {
    return undefined
  }
  if (trackingRecord) {
    copy.receipts.delete(trackingRecord)
  }
  const census = copy.census
  if (census?.environmentId !== environmentId || !census.listed.delete(worktreeId)) {
    return undefined
  }
  if (
    census.uncovered.delete(worktreeId) &&
    census.uncovered.size === 0 &&
    census.listed.size > 0 &&
    census.runtimeId === runtimeId &&
    !censusMember
  ) {
    return completeFromTabs(copy, readState())
  }
  return undefined
}

export function forgetWebChatReadMarkCensus(environmentId: string): void {
  const copy = pendingMigration()
  if (copy?.census?.environmentId === environmentId) {
    delete copy.census
  }
}
