/**
 * A local project the WSL host now owns. Its existing chats stay on this computer, so the desktop
 * lists it read-only under its own entry; new work, terminals and edits belong to the host.
 */
export type WslMovedProjectKind = 'repo' | 'folder'

export type WslMovedProject = {
  kind: WslMovedProjectKind
  /** The local row's id; the host's row carries the same id on another host. */
  id: string
  displayName: string
  /** The local (UNC) path the project ran at before the move. */
  path: string
  distro: string
}

/** "Use on this computer again": the whole move it undid comes back, never part of one. */
export type WslMoveUseLocallyResult =
  | { released: true; distro: string; repoIds: string[]; folderWorkspaceIds: string[] }
  | {
      released: false
      reason:
        | 'gated-off'
        | 'not-moved'
        | 'superseded'
        | 'move-running'
        | 'failed'
        /** The host's copies of the project's terminals did not stop; its agents may still run. */
        | 'host-still-running'
        /** The host is not answering, so its copies of the project's agents may still run. */
        | 'host-unreachable'
        /** The reload would drop unsaved files in the move's own workspaces. */
        | 'unsaved-files'
      detail?: string
      /** `unsaved-files`: the asked-about workspaces that the move brings back. */
      unsavedWorkspaceIds?: string[]
      /** `superseded`: the newest move of the distro, which has to come back first. */
      newerMove?: { repoIds: string[]; folderWorkspaceIds: string[] }
      /** Refused after the host's terminals were put to sleep; opening the project there resumes them. */
      hostTerminalsAsleep?: true
    }
