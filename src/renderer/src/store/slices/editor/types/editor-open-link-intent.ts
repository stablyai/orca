import type { ExecutionHostId } from '../../../../../../shared/execution-host'

/** A link's source, captured before async path resolution. */
export type EditorOpenLinkIntent = {
  workspaceId: string
  sourceTabId: string
  /** The source tab's owning host at capture; null when the tab carries none. */
  hostId: ExecutionHostId | null
  /** Set only for "Open in this group"; otherwise follow the source tab's current group. */
  targetGroupId?: string
}

/** The view an open actually created or reused; the file id alone names only the document. */
export type EditorOpenResult = {
  fileId: string
  viewStateId: string
  groupId: string
}
