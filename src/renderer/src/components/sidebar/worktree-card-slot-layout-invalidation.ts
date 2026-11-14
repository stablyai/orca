import type { AppState } from '@/store/types'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { readRecordChanges } from '@/store/keyed-record-change-reads'

export type SlotLayout = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'migrationUnsupportedByPtyId'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'paneForegroundAgentByPaneKey'
>

type KeyedRecord = Readonly<Record<string, unknown>>
const EMPTY_RECORD: KeyedRecord = Object.freeze({})

/** Visits every key whose value differs, using keyed-record journal entries when available. */
export function forEachChangedKey(
  before: KeyedRecord | undefined,
  after: KeyedRecord | undefined,
  visit: (key: string) => void
): void {
  const previous = before ?? EMPTY_RECORD
  const next = after ?? EMPTY_RECORD
  if (previous === next) {
    return
  }
  const changes = readRecordChanges(next, previous)
  if (changes?.kind === 'addressed') {
    changes.keys.forEach(visit)
    return
  }
  for (const key in next) {
    if (Object.hasOwn(next, key) && previous[key] !== next[key]) {
      visit(key)
    }
  }
  for (const key in previous) {
    if (Object.hasOwn(previous, key) && !Object.hasOwn(next, key)) {
      visit(key)
    }
  }
}

function sameTabIds(
  previous: readonly { id: string }[] | undefined,
  next: readonly { id: string }[] | undefined
): boolean {
  const previousIds = new Set((previous ?? []).map((tab) => tab.id))
  const nextIds = new Set((next ?? []).map((tab) => tab.id))
  return previousIds.size === nextIds.size && [...nextIds].every((id) => previousIds.has(id))
}

/**
 * Adds the workspaces a layout change can touch. Returns false when the change moved panes between
 * workspaces (a tab or chat added, removed or moved, or a pane in a tab no workspace owns): only
 * then must every slot be re-checked.
 */
export function addChangedLayoutWorkspaces(
  result: Set<string>,
  before: SlotLayout,
  after: SlotLayout,
  tabOwners: ReadonlyMap<string, string>,
  includePane: (paneKey: string) => void
): boolean {
  let scoped = true
  forEachChangedKey(before.tabsByWorktree, after.tabsByWorktree, (worktreeId) => {
    if (!sameTabIds(before.tabsByWorktree[worktreeId], after.tabsByWorktree[worktreeId])) {
      scoped = false
    }
    result.add(worktreeId)
  })
  if (!scoped) {
    return false
  }
  forEachChangedKey(before.unifiedTabsByWorktree, after.unifiedTabsByWorktree, (worktreeId) => {
    const previous = getStructuredAgentSessionTabsByPaneKey(
      before.unifiedTabsByWorktree?.[worktreeId]
    )
    const next = getStructuredAgentSessionTabsByPaneKey(after.unifiedTabsByWorktree?.[worktreeId])
    if (previous === next) {
      return
    }
    if (previous.size !== next.size) {
      scoped = false
      return
    }
    for (const [paneKey, tab] of next) {
      if (!previous.has(paneKey)) {
        scoped = false
        return
      }
      if (previous.get(paneKey) !== tab) {
        result.add(worktreeId)
      }
    }
  })
  if (!scoped) {
    return false
  }
  const addTabOwner = (tabId: string): void => {
    const owner = tabOwners.get(tabId)
    if (owner) {
      result.add(owner)
    } else {
      scoped = false
    }
  }
  forEachChangedKey(before.ptyIdsByTabId, after.ptyIdsByTabId, addTabOwner)
  forEachChangedKey(before.terminalLayoutsByTabId, after.terminalLayoutsByTabId, addTabOwner)
  if (!scoped) {
    return false
  }
  forEachChangedKey(
    before.migrationUnsupportedByPtyId,
    after.migrationUnsupportedByPtyId,
    (ptyId) => {
      for (const entry of [
        before.migrationUnsupportedByPtyId[ptyId],
        after.migrationUnsupportedByPtyId[ptyId]
      ]) {
        const parsed = entry?.paneKey ? parsePaneKey(entry.paneKey) : null
        const owner = parsed && tabOwners.get(parsed.tabId)
        if (owner) {
          result.add(owner)
        }
      }
    }
  )
  forEachChangedKey(
    before.paneForegroundAgentByPaneKey,
    after.paneForegroundAgentByPaneKey,
    includePane
  )
  return true
}
