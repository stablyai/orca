// Pure types: shared by the copy engine, the main process, the relay and the renderer.

/** `same-stream`: the source's stream; `child`: a sparse stream of its own; `other-stream`: an existing stream. */
export type WorkspaceCopyMode = 'same-stream' | 'child' | 'other-stream'

/** `child`: a new stream of its own under `parent` (default: the workspace's stream), as a Git branch;
 *  `same-stream` / `stream`: work directly on the workspace's stream or another existing one. */
export type WorkspaceCopyStreamChoice =
  | { kind: 'child'; parent?: string }
  | { kind: 'same-stream' }
  | { kind: 'stream'; stream: string }

export type WorkspaceCopySourceSummary = {
  client: string
  root: string
  stream: string
}

export type WorkspaceCopyProgressPhase =
  | 'checking'
  | 'copying'
  | 'creating-client'
  | 'adopting'
  | 'restoring'
  | 'aligning'
  | 'rebinding'
  | 'verifying'
  | 'rolling-back'

export type WorkspaceCopyProgress = {
  phase: WorkspaceCopyProgressPhase
  message: string
}

export type WorkspaceCopyCreateOptions = {
  /** 1-24 letters, digits or hyphens. */
  name: string
  stream?: WorkspaceCopyStreamChoice
  /** Skips each Unity project's Library/PackageCache; Unity refills it on first open. */
  skipPackageCache?: boolean
  /** Workspace-relative folders left out of the copy (tracked files in them come back from the depot). */
  extraExcludedFolders?: readonly string[]
  /** Refuse when the drive has less free space than this. */
  minFreeBytes?: number
}

export type WorkspaceCopySpace = {
  /** Bytes robocopy reported copying; null when its summary could not be read. */
  copiedBytes: number | null
  /** How much the drive's free space dropped during the copy. */
  usedBytes: number
  /** True when the copy cost far less than its size, i.e. the drive block-cloned it. */
  cloned: boolean | null
  freeBytesAfter: number
}

export type WorkspaceCopyCreateResult = {
  name: string
  copyRoot: string
  client: string
  stream: string
  mode: WorkspaceCopyMode
  /** Why this stream, in words for the user. */
  streamChoice: string
  source: WorkspaceCopySourceSummary
  markerPath: string
  unityProjects: string[]
  /** One line to run in the copy's Unity editor when the project uses Perforce version control. */
  unityVersionControlBinding: string | null
  openFilesRestored: number
  addsRemoved: number
  trackedInSkippedFolders: number
  changedDuringCopy: number
  alignedFiles: number | null
  rewritten: string[]
  space: WorkspaceCopySpace
  warnings: string[]
  seconds: Record<string, number>
}

export type WorkspaceCopyListEntry = {
  name: string
  client: string
  copyRoot: string
  stream: string | null
  mode: WorkspaceCopyMode | null
  folderExists: boolean
  clientExists: boolean
  markerExists: boolean
  created: string | null
  createdBy: string | null
}

export type WorkspaceCopyListResult = {
  source: WorkspaceCopySourceSummary
  copiesDir: string
  copies: WorkspaceCopyListEntry[]
  /** False when the server could not be asked; entries then come from the markers on disk only. */
  serverChecked: boolean
  serverError?: string
}

export type BlockCloningState = 'verified' | 'not-cloning' | 'unknown'

export type WorkspaceCopyReadiness = {
  ready: boolean
  /** Reasons a copy cannot be made, in words for the user. */
  problems: string[]
  warnings: string[]
  source: WorkspaceCopySourceSummary | null
  copiesDir: string | null
  windowsBuild: number | null
  fileSystemFreeBytes: number | null
  blockCloning: BlockCloningState | null
}

export type WorkspaceCopyPendingChange = {
  change: number
  description: string
  shelvedFiles: number
}

/** A program with the copy open: a handle in its folder, or a path inside it on its command line. */
export type WorkspaceCopyHolder = {
  pid: number
  name: string
  commandLine: string
  /** Start time (ms), so ending it can never reach a reused pid; null when the host cannot tell. */
  startedAt: number | null
  /** Optional fields: absent from relays that predate them. */
  parentPid?: number | null
  /** The shallowest folder of the copy it has open; null when only its command line names the copy. */
  heldFolder?: string | null
  /** False for Explorer and programs Orca cannot end; the user closes those. */
  canEnd?: boolean
}

/** A holder the user agreed to end: the pid and start time they were shown. */
export type WorkspaceCopyHolderConsent = Pick<WorkspaceCopyHolder, 'pid' | 'startedAt'>

export type WorkspaceCopyRemovalOptions = {
  /** Reverts the copy's open files (`revert -k`); their edits are lost with the folder. */
  revertOpenFiles?: boolean
  /** Deletes shelved files in the copy's changelists. */
  deleteShelves?: boolean
  /** Ends these programs first; anything unsaved in them is lost. */
  endHolders?: WorkspaceCopyHolderConsent[]
}

export type WorkspaceCopyRemovalPreview = {
  name: string
  client: string
  copyRoot: string
  markerPath: string
  clientExists: boolean
  folderExists: boolean
  stream: string | null
  openFiles: { count: number; sample: string[] }
  pendingChanges: WorkspaceCopyPendingChange[]
  /** The copy's own child stream: deleted when nothing was submitted to it, otherwise kept. */
  childStream: {
    stream: string
    submittedChanges: number
    parent: string | null
  } | null
  /** Labels of the programs holding the copy; Windows will not delete a folder they hold. */
  processesHoldingFolder: string[]
  /** The same processes in full; absent from relays that predate it. */
  holders?: WorkspaceCopyHolder[]
  /** What removal refuses until the user opts in. */
  blockers: { openFiles: boolean; shelves: boolean; holders?: boolean }
}

export type WorkspaceCopyRemovalResult = {
  name: string
  client: string
  clientDeleted: boolean
  folderDeleted: boolean
  revertedFiles: number
  deletedChanges: number[]
  deletedShelves: number[]
  streamDeleted: boolean
  /** Set when a child stream was kept because it has submitted work. */
  note: string | null
}

/** Copy IPC results carry the engine's message instead of Electron's wrapped error. */
export type WorkspaceCopyIpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type PerforceStreamEntry = {
  stream: string
  name: string
  type: string
  parent: string | null
}

/** Streams a copy can go on, for the stream picker; `sourceStream` is the workspace's own. */
export type PerforceStreamList = { sourceStream: string; streams: PerforceStreamEntry[] }

/** What the create-workspace flow reports about a copy it made, for the success toast. */
export type PerforceCopyCreateSummary = {
  name: string
  copyRoot: string
  stream: string
  streamChoice: string
  space: WorkspaceCopySpace
  warnings: string[]
  unityVersionControlBinding: string | null
}
