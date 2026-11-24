import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import { useAppStore } from '@/store'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import type { HostGroup, Member } from './structured-agent-session-status-membership'

/** How often a chat nobody is reading republishes its streaming preview into the store. */
export const HIDDEN_PREVIEW_INTERVAL_MS = 250

// What a working turn streams: the newest prose, the tool it is in, and the stamp each frame moves.
// Any other field is a transition.
const PREVIEW_KEYS: ReadonlySet<string> = new Set([
  'lastAssistantMessage',
  'toolName',
  'toolInput',
  'updatedAt'
])

/** Whether `next` only moves a still-working turn's streaming preview past `previous`. */
export function isStreamingPreviewChange(
  previous: AgentSessionStatusSummary | null | undefined,
  next: AgentSessionStatusSummary | null | undefined
): boolean {
  if (!previous || !next || previous.status !== 'working' || next.status !== 'working') {
    return false
  }
  const before: Record<string, unknown> = previous
  const after: Record<string, unknown> = next
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!PREVIEW_KEYS.has(key) && !sameValue(before[key], after[key])) {
      return false
    }
  }
  return true
}

// Summaries cross IPC, so an unchanged nested field (children, provider session) arrives as a new object.
function sameValue(previous: unknown, next: unknown): boolean {
  return (
    previous === next ||
    (typeof previous === 'object' &&
      typeof next === 'object' &&
      previous !== null &&
      next !== null &&
      JSON.stringify(previous) === JSON.stringify(next))
  )
}

/** A hidden chat's streaming frames wait for the next interval; the front chat and every status
 *  transition project at once. */
export function createHiddenPreviewCoalescer(
  flush: (sessionIds: ReadonlySet<string>) => void,
  intervalMs = HIDDEN_PREVIEW_INTERVAL_MS
): {
  defer: (
    sessionId: string,
    members: Iterable<Member>,
    next: AgentSessionStatusSummary | null | undefined,
    frontTabId: string | null
  ) => boolean
  dispose: () => void
} {
  const waiting = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    defer: (sessionId, members, next, frontTabId) => {
      let any = false
      for (const member of members) {
        if (
          member.tab.id === frontTabId ||
          !isStreamingPreviewChange(member.captured?.summary, next)
        ) {
          return false
        }
        any = true
      }
      if (!any) {
        return false
      }
      waiting.add(sessionId)
      timer ??= setTimeout(() => {
        timer = null
        const due = new Set(waiting)
        waiting.clear()
        flush(due)
      }, intervalMs)
      return true
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      waiting.clear()
    }
  }
}

type HiddenPreviewCoalescer = ReturnType<typeof createHiddenPreviewCoalescer>

/** The tabs of the named sessions that project now; with `previews`, a hidden chat's streaming
 *  frame waits for its interval instead. */
export function sessionMembers(
  group: HostGroup,
  sessionIds: Iterable<string>,
  previews?: HiddenPreviewCoalescer
): Set<Member> {
  const selected = new Set<Member>()
  const frontTabId = previews ? (selectFrontTab(useAppStore.getState())?.id ?? null) : null
  const snapshot = previews ? group.feed.getSnapshot() : null
  for (const sessionId of sessionIds) {
    const members = group.membersBySession.get(sessionId)
    if (members && !previews?.defer(sessionId, members, snapshot?.get(sessionId), frontTabId)) {
      members.forEach((member) => selected.add(member))
    }
  }
  return selected
}

/** One host's feed ticks: `null` asks for every member, a hidden chat's streaming frame arrives
 *  later through `onDue`, and owed members ride along with each named tick. */
export function subscribeHostGroupStatus(
  group: HostGroup,
  onDue: (selected: Set<Member>) => void,
  onChange: (selected: Set<Member> | null) => void
): () => void {
  const previews = createHiddenPreviewCoalescer((due) => onDue(sessionMembers(group, due)))
  const stopFeed = group.feed.subscribe((change) => {
    if (change === null) {
      onChange(null)
      return
    }
    const selected = sessionMembers(group, change, previews)
    // Membership changes prune superseded members, so the debt holds only current tabs.
    group.owed.forEach((member) => selected.add(member))
    onChange(selected)
  })
  return () => {
    previews.dispose()
    stopFeed()
  }
}
