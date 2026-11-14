export type RuntimeTerminalPathOpenTarget =
  | {
      kind: 'worktree-file'
      provider: 'local' | 'ssh'
      relativePath: string
      absolutePath: string
    }
  | {
      kind: 'absolute-file'
      provider: 'local' | 'ssh'
      absolutePath: string
      grantId: string
      readOnly?: true
      /** The file's size when granted; hosts with in-place files report it. */
      byteLength?: number
      /** Hosts with in-place files mark a file a grant can't serve as text. */
      binary?: true
    }
  | { kind: 'unsupported'; reason: string }

// Why: older hosts ignore crossWorkspace, so their refusal is no proof that no host workspace holds the path.
export const TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY =
  'files.resolve-terminal-path.cross-workspace.v1' as const

// Why: older hosts grant a path outside their workspaces only to the terminal that printed it.
export const TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY =
  'files.resolve-terminal-path.absolute-files.v1' as const

// Why: older hosts report neither a grant's size nor binary content, so their grant can't be
// proven to read and save; a file another workspace holds opens there, as before.
export const TERMINAL_PATH_IN_PLACE_FILES_RUNTIME_CAPABILITY =
  'files.resolve-terminal-path.in-place-files.v1' as const

/**
 * The largest file opened in place through a grant. Hosts cap grant reads and saves at 512 KB and a save
 * must fit one request frame; half that leaves room to edit before a save outgrows the grant.
 */
export const TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES = 256 * 1024

/** SSH workspaces on a server grant no file outside them; the one refusal that means "open it where it lives". */
export const SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE =
  "Files outside an SSH workspace can't be opened from another device yet."

export type RuntimeTerminalPathResolution = {
  worktree: string
  relativePath: string | null
  absolutePath: string | null
  exists: boolean
  isDirectory: boolean
  openTarget?: RuntimeTerminalPathOpenTarget
}
