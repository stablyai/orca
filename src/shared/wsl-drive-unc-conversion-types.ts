/** Converting a UNC Windows-drive project to its drive path (D1c); desktop-only IPC. */
import type { WslMoveBlocker } from './wsl-move/wsl-move-driver-types'

export type WslDriveUncConversionRequest = {
  distro: string
  /** The repos to convert; each must be a local UNC project on one of the distro's drives. */
  repoIds: string[]
  folderWorkspaceIds?: string[]
}

export type WslDriveUncConversionBlocker =
  /** A conversion is waiting for the restart that runs it. */
  | { kind: 'conversion-pending' }
  /** Not a UNC Windows-drive project Orca can convert in place (wsl-drive-unc-project-scope.ts). */
  | {
      kind: 'not-convertible'
      id: string
      reason:
        | 'not-in-scope'
        | 'mixed-locations'
        | 'not-local'
        | 'duplicate-windows-project'
        | 'overlaps-refused-project'
    }
  | { kind: 'windows-git-missing' }
  /** WSL Git made these worktrees; their links are Linux paths Windows Git can't follow. */
  | { kind: 'wsl-authored-worktrees'; repoId: string; paths: string[] }
  /** Its saved state can't be re-keyed: a project also holds an unconverted repo, or ids collide. */
  | { kind: 'state-conflict'; detail: string }

export type WslDriveUncConversionResult =
  /** Journaled with the panes asleep; the app restarts and converts before the window opens. */
  | { outcome: 'restarting'; migrationId: string }
  | { outcome: 'refused'; blockers: WslDriveUncConversionBlocker[] }
  /** Terminals in scope are busy, or could not be put to sleep; nothing changed. */
  | { outcome: 'terminals-blocked'; blockers: WslMoveBlocker[] }
  | { outcome: 'pause-failed'; detail: string }
