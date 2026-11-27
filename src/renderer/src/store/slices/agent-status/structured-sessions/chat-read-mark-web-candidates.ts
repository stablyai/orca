import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { RuntimeMobileSessionSnapshotTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import {
  CHAT_READ_MARK_FIELDS,
  type ChatReadMarkField
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import { paneKeyLeaf } from './chat-read-mark-legacy-index'

export type LegacyIndex = Record<ChatReadMarkField, Map<string, string[]>>
export type ScanChatSessions = (visit: (sessionId: string) => void) => void

type Tabs = readonly RuntimeMobileSessionSnapshotTab[]
type ChatMembership = Map<string, { scanMark: boolean }>
type CandidateIndex = { legacyIndex: LegacyIndex; candidates: Map<string, string> }

function scanTabs(tabs: Tabs, visit: (sessionId: string) => void): void {
  for (const tab of tabs) {
    if (tab.type === 'agent-session') {
      visit(tab.sessionId)
    }
  }
}

function sameRows(previous: Tabs | undefined, tabs: Tabs): boolean {
  if (!previous || previous.length !== tabs.length) {
    return false
  }
  for (let index = 0; index < tabs.length; index++) {
    if (previous[index] !== tabs[index]) {
      return false
    }
  }
  return true
}

function recordCandidate(copy: CandidateIndex, sessionId: string): void {
  const leaf = paneKeyLeaf(chatPaneKey(sessionId))
  if (CHAT_READ_MARK_FIELDS.some((field) => copy.legacyIndex[field].has(leaf))) {
    copy.candidates.set(leaf, sessionId)
  }
}

export function collectReplyCandidates(
  copy: CandidateIndex,
  tabs: Tabs,
  scanChatSessions?: ScanChatSessions
): void {
  const visited = new Set<string>()
  const visit = (sessionId: string): void => {
    if (!visited.has(sessionId)) {
      visited.add(sessionId)
      recordCandidate(copy, sessionId)
    }
  }
  if (scanChatSessions) {
    scanChatSessions(visit)
  } else {
    scanTabs(tabs, visit)
  }
}

export function createWorkspaceCandidateCollector(copy: CandidateIndex) {
  let previousTabs: WeakRef<Tabs> | undefined
  let membership: ChatMembership = new Map()
  let scanMark = false
  let knownCount = 0
  let nextMembership: ChatMembership | undefined

  const visit = (sessionId: string): void => {
    const known = membership.get(sessionId)
    if (known) {
      // Multiple tabs may display the same conversation.
      if (known.scanMark !== scanMark) {
        known.scanMark = scanMark
        knownCount++
      }
      return
    }
    nextMembership ??= new Map()
    if (!nextMembership.has(sessionId)) {
      nextMembership.set(sessionId, { scanMark })
      recordCandidate(copy, sessionId)
    }
  }

  return (tabs: Tabs, scanChatSessions?: ScanChatSessions): void => {
    const previous = previousTabs?.deref()
    if (previous === tabs) {
      return
    }
    previousTabs = new WeakRef(tabs)
    if (sameRows(previous, tabs)) {
      return
    }

    scanMark = !scanMark
    knownCount = 0
    if (scanChatSessions) {
      scanChatSessions(visit)
    } else {
      scanTabs(tabs, visit)
    }
    if (!nextMembership && knownCount === membership.size) {
      return
    }

    const current = nextMembership ?? new Map()
    for (const [sessionId, seen] of membership) {
      if (seen.scanMark === scanMark) {
        current.set(sessionId, seen)
      }
    }
    membership = current
    nextMembership = undefined
  }
}
