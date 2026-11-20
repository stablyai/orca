import type { AppState } from '../../../store/types'
import { isDecorativeAgentTitleFrameChange } from '../../../../../shared/agent-status/title/agent-decorative-title-signature'
import { readRecordChanges } from '../../../store/record-transitions/keyed-record-change-reads'
import { createWorktreeTabBucketProjection } from '../tabs/worktree-tab-bucket-projection'

type TabsByWorktree = AppState['tabsByWorktree']
type TerminalTab = TabsByWorktree[string][number]
type UnifiedTabsByWorktree = AppState['unifiedTabsByWorktree']
type UnifiedTab = UnifiedTabsByWorktree[string][number]

const TERMINAL_TAB_LIVE_TITLE_KEYS = new Set<keyof TerminalTab>(['title'])
// Handoff flags are stripped from sessions; toggling alone must not rebuild durable payloads.
const TERMINAL_TAB_TRANSIENT_SESSION_KEYS = new Set<keyof TerminalTab>([
  'pendingActivationSpawn',
  'recovery'
])

function terminalTabChangedForSession(prev: TerminalTab, next: TerminalTab): boolean {
  if (prev === next) {
    return false
  }
  const keys = new Set([
    ...(Object.keys(prev) as (keyof TerminalTab)[]),
    ...(Object.keys(next) as (keyof TerminalTab)[])
  ])
  for (const key of keys) {
    if (TERMINAL_TAB_LIVE_TITLE_KEYS.has(key) || TERMINAL_TAB_TRANSIENT_SESSION_KEYS.has(key)) {
      continue
    }
    if (prev[key] !== next[key]) {
      return true
    }
  }
  return prev.title !== next.title && !isDecorativeAgentTitleFrameChange(prev.title, next.title)
}
export function createTerminalSessionTabsProjection() {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) =>
      !terminalTabChangedForSession(previousTab, nextTab)
  })
}

function unifiedTabChangedForSession(prev: UnifiedTab, next: UnifiedTab): boolean {
  if (prev === next) {
    return false
  }
  const keys = new Set([
    ...(Object.keys(prev) as (keyof UnifiedTab)[]),
    ...(Object.keys(next) as (keyof UnifiedTab)[])
  ])
  for (const key of keys) {
    if (key === 'label') {
      continue
    }
    if (prev[key] !== next[key]) {
      return true
    }
  }
  if (prev.label === next.label) {
    return false
  }
  if (prev.contentType !== 'terminal' || next.contentType !== 'terminal') {
    return true
  }
  return !isDecorativeAgentTitleFrameChange(prev.label, next.label)
}
export function createUnifiedSessionTabsProjection() {
  return createWorktreeTabBucketProjection<UnifiedTab, UnifiedTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) => !unifiedTabChangedForSession(previousTab, nextTab)
  })
}

// Title changes only: the rest of a tab feeds other saved fields (layouts, reconnect, groups).
export const TERMINAL_TAB_TITLE_KEYS: ReadonlySet<string> = new Set([
  'title',
  'defaultTitle',
  'generatedTitle'
])
export const UNIFIED_TAB_LABEL_KEYS: ReadonlySet<string> = new Set(['label', 'generatedLabel'])

function onlyKeysChanged(
  previous: readonly { id: string }[],
  next: readonly { id: string }[],
  allowed: ReadonlySet<string>
): boolean {
  if (previous.length !== next.length) {
    return false
  }
  return next.every((tab, index) => {
    const before: Record<string, unknown> = previous[index]!
    const after: Record<string, unknown> = tab
    if (before === after) {
      return true
    }
    if (before.id !== after.id) {
      return false
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] !== after[key] && !allowed.has(key)) {
        return false
      }
    }
    return true
  })
}

/** Workspaces whose saved bucket changed, when each kept its tabs and changed only `allowed` keys;
 *  else 'whole'. Reads the store's annotated keys, so it visits only the buckets that were written. */
export function changedTitleBuckets(
  previous: Readonly<Record<string, readonly { id: string }[]>>,
  next: Readonly<Record<string, readonly { id: string }[]>>,
  previousSource: object,
  nextSource: object,
  allowed: ReadonlySet<string>
): Set<string> | 'whole' {
  const changes = readRecordChanges(nextSource, previousSource)
  if (changes?.kind !== 'addressed' || changes.added.length > 0 || changes.deleted.size > 0) {
    return 'whole'
  }
  const worktreeIds = new Set<string>()
  for (const worktreeId of changes.keys) {
    const before = previous[worktreeId]
    const after = next[worktreeId]
    if (before === after) {
      continue
    }
    if (!before || !after || !onlyKeysChanged(before, after, allowed)) {
      return 'whole'
    }
    worktreeIds.add(worktreeId)
  }
  return worktreeIds.size > 0 ? worktreeIds : 'whole'
}
