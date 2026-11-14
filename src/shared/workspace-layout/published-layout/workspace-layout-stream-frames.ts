// layout.subscribe frame contract shared by runtime producers and clients (2.4).

import type { PublishedWorkspaceLayout } from './workspace-layout-published'
import type { WorkspaceLayoutRecordChange } from './workspace-layout-records'

/** Stream position after this frame; rises once per change during the host’s lifetime. layout.apply replies identify their effect’s position. Absent on older hosts. */
type Sequenced = { seq?: number }

export type WorkspaceLayoutEvent = (
  | { type: 'workspace'; key: string; layout: PublishedWorkspaceLayout }
  | { type: 'removed'; key: string }
) &
  Sequenced

/** One records frame per operation. An epoch mismatch or a gap before seq requires a fresh snapshot. */
export type WorkspaceLayoutRecordsFrame = {
  type: 'records'
  epoch: string
  seq: number
  workspaces: WorkspaceLayoutRecordChange[]
}

/** What a host's stream hands its subscribers: an older host's per-workspace events, or records. */
export type WorkspaceLayoutStreamEvent = WorkspaceLayoutEvent | WorkspaceLayoutRecordsFrame

export type WorkspaceLayoutSnapshotEntry = { key: string; layout: PublishedWorkspaceLayout }

export type WorkspaceLayoutStreamFrame =
  // subscriptionId names the stream for `layout.unsubscribe`; a reader does not need it.
  | ({
      type: 'snapshot'
      subscriptionId?: string
      workspaces: WorkspaceLayoutSnapshotEntry[]
      /** A layout-owner host's stream epoch; its records frames carry the same one. */
      epoch?: string
    } & Sequenced)
  | WorkspaceLayoutStreamEvent
  | { type: 'end' }

export type WorkspaceLayoutChangeFrame = Exclude<WorkspaceLayoutStreamFrame, { type: 'end' }>

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

/** A frame's stream position, read even from a frame this build cannot read otherwise. */
export function readWorkspaceLayoutFramePosition(value: unknown): number | undefined {
  const seq = isRecord(value) ? value.seq : undefined
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

function sequenced(value: Record<string, unknown>): Sequenced {
  const seq = readWorkspaceLayoutFramePosition(value)
  return seq === undefined ? {} : { seq }
}

function isSnapshotEntry(value: unknown): value is WorkspaceLayoutSnapshotEntry {
  return isRecord(value) && isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
}

const RECORD_KINDS = ['tabs', 'paneTrees', 'bindings', 'editorFiles', 'browserTabs'] as const

const isKeyList = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every(isKey))

function isRecordChanges(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.set === undefined || (Array.isArray(value.set) && value.set.every(isRecord))) &&
      isKeyList(value.removed) &&
      isKeyList(value.order))
  )
}

// Validate only top-level shape; nested fields follow the published host contract.
function isRecordChange(value: unknown): value is WorkspaceLayoutRecordChange {
  if (!isRecord(value) || !isKey(value.key)) {
    return false
  }
  switch (value.change) {
    case 'removed':
      return true
    case 'layout':
      return isPublishedWorkspaceLayout(value.layout)
    case 'records':
      return (
        (value.workspace === undefined ||
          (isRecord(value.workspace) &&
            typeof value.workspace.worktreeId === 'string' &&
            Array.isArray(value.workspace.groups))) &&
        RECORD_KINDS.every((kind) => isRecordChanges(value[kind]))
      )
    default:
      return false
  }
}

function readRecordsFrame(value: Record<string, unknown>): WorkspaceLayoutRecordsFrame | null {
  const seq = readWorkspaceLayoutFramePosition(value)
  return typeof value.epoch === 'string' &&
    value.epoch.length > 0 &&
    seq !== undefined &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(isRecordChange)
    ? { type: 'records', epoch: value.epoch, seq, workspaces: value.workspaces }
    : null
}

const FRAME_TYPES: readonly unknown[] = ['snapshot', 'workspace', 'removed', 'records', 'end']

/** A type this build reads: a newer host's other types are skipped, never a reason to resync. */
export function isKnownWorkspaceLayoutFrameType(value: unknown): boolean {
  return isRecord(value) && FRAME_TYPES.includes(value.type)
}

/** Null for a malformed frame or a frame type this build does not know (a newer host's). */
export function readWorkspaceLayoutStreamFrame(value: unknown): WorkspaceLayoutStreamFrame | null {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'snapshot':
      return Array.isArray(value.workspaces) &&
        value.workspaces.every(isSnapshotEntry) &&
        (value.epoch === undefined || isKey(value.epoch))
        ? {
            type: 'snapshot',
            workspaces: value.workspaces,
            ...sequenced(value),
            ...(isKey(value.epoch) ? { epoch: value.epoch } : {})
          }
        : null
    case 'records':
      return readRecordsFrame(value)
    case 'workspace':
      return isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
        ? { type: 'workspace', key: value.key, layout: value.layout, ...sequenced(value) }
        : null
    case 'removed':
      return isKey(value.key) ? { type: 'removed', key: value.key, ...sequenced(value) } : null
    case 'end':
      return { type: 'end' }
    default:
      return null
  }
}
