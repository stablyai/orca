// The frames `layout.subscribe` sends (design 2.4), shared by the runtime that emits them and the
// one client that reads them.

import type { PublishedWorkspaceLayout } from './workspace-layout-published'

export type WorkspaceLayoutEvent =
  | { type: 'workspace'; key: string; layout: PublishedWorkspaceLayout }
  | { type: 'removed'; key: string }

export type WorkspaceLayoutSnapshotEntry = { key: string; layout: PublishedWorkspaceLayout }

export type WorkspaceLayoutStreamFrame =
  // subscriptionId names the stream for `layout.unsubscribe`; a reader must not need it.
  | { type: 'snapshot'; subscriptionId?: string; workspaces: WorkspaceLayoutSnapshotEntry[] }
  | WorkspaceLayoutEvent
  | { type: 'end' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Checks the top-level shape only; the fields inside are the host's published contract.
function isPublishedWorkspaceLayout(value: unknown): value is PublishedWorkspaceLayout {
  return (
    isRecord(value) &&
    typeof value.worktreeId === 'string' &&
    Array.isArray(value.groups) &&
    Array.isArray(value.tabs) &&
    Array.isArray(value.editorFiles) &&
    Array.isArray(value.browserTabs)
  )
}

function isSnapshotEntry(value: unknown): value is WorkspaceLayoutSnapshotEntry {
  return isRecord(value) && isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
}

/** Null for a malformed frame or a frame type this build does not know (a newer host's). */
export function readWorkspaceLayoutStreamFrame(value: unknown): WorkspaceLayoutStreamFrame | null {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'snapshot':
      if (!Array.isArray(value.workspaces) || !value.workspaces.every(isSnapshotEntry)) {
        return null
      }
      return isKey(value.subscriptionId)
        ? { type: 'snapshot', subscriptionId: value.subscriptionId, workspaces: value.workspaces }
        : { type: 'snapshot', workspaces: value.workspaces }
    case 'workspace':
      return isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
        ? { type: 'workspace', key: value.key, layout: value.layout }
        : null
    case 'removed':
      return isKey(value.key) ? { type: 'removed', key: value.key } : null
    case 'end':
      return { type: 'end' }
    default:
      return null
  }
}
