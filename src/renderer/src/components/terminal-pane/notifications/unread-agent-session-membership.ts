import { readTabMapChanges } from '@/store/keyed-record-change-reads'

type MembershipTab = { id: string; contentType?: string }
type TabBuckets = Readonly<Record<string, readonly MembershipTab[] | undefined>>
type IndexedBucket = { source: readonly MembershipTab[]; ids: ReadonlySet<string> }

const emptyBuckets: TabBuckets = {}
let source: TabBuckets = emptyBuckets
const buckets = new Map<string, IndexedBucket>()
const membershipCounts = new Map<string, number>()

export function hasUnreadAgentSessionTab(
  tabsByWorktree: TabBuckets | undefined,
  tabId: string
): boolean {
  const next = tabsByWorktree ?? emptyBuckets
  if (source !== next) {
    const changes = readTabMapChanges(next, source)
    // Unknown provenance includes ordinary writes; unchanged bucket identities still bound the work.
    const workspaceIds =
      changes?.kind === 'addressed'
        ? changes.workspaceIds
        : new Set([...buckets.keys(), ...Object.keys(next)])
    for (const workspaceId of workspaceIds) {
      const tabs = Object.hasOwn(next, workspaceId) ? next[workspaceId] : undefined
      const previous = buckets.get(workspaceId)
      if (previous?.source === tabs) {
        continue
      }
      for (const id of previous?.ids ?? []) {
        const count = membershipCounts.get(id) ?? 0
        if (count > 1) {
          membershipCounts.set(id, count - 1)
        } else {
          membershipCounts.delete(id)
        }
      }
      if (!tabs) {
        buckets.delete(workspaceId)
        continue
      }
      const ids = new Set<string>()
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session') {
          ids.add(tab.id)
        }
      }
      for (const id of ids) {
        membershipCounts.set(id, (membershipCounts.get(id) ?? 0) + 1)
      }
      buckets.set(workspaceId, { source: tabs, ids })
    }
    source = next
  }
  return membershipCounts.has(tabId)
}
