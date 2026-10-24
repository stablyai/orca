/** A WSL-runtime project on a Windows drive, converted to Windows Git (D1c); desktop-only IPC. */
import type { LocalWindowsRuntimePreference } from './project-execution-runtime'

export type WslDriveProjectBlocker =
  /** Its runtime isn't WSL (or already uses Windows Git), so there is nothing to convert. */
  | { kind: 'not-wsl-runtime' }
  /** WSL is missing or the distro is gone; the runtime must be repaired first. */
  | { kind: 'runtime-needs-repair' }
  /** A folder of the project isn't on a Windows drive (inside a distro, or on another host). */
  | { kind: 'not-windows-drive'; repoId: string }
  | { kind: 'windows-git-missing' }
  /**
   * WSL Git made these worktrees, so their links are Linux paths. Windows Git lists them as
   * prunable, and the `git worktree prune` after any removal would delete their metadata.
   */
  | { kind: 'wsl-authored-worktrees'; repoId: string; paths: string[] }
  /** New worktrees would be created inside the distro, where Windows Git is slow. */
  | { kind: 'worktree-folder-in-distro'; repoId: string }

export type WslDriveProjectRepoPreview = {
  repoId: string
  path: string
  /** Windows Git's effective `core.autocrlf`; WSL Git needs the same value to see a clean tree. */
  windowsAutocrlf: string | null
  /** Set in the repo itself, so WSL Git already reads it. */
  localAutocrlf: string | null
}

export type WslDriveProjectPreview = {
  projectId: string
  distro: string | null
  repos: WslDriveProjectRepoPreview[]
  blockers: WslDriveProjectBlocker[]
}

export type WslDriveProjectConversionResult =
  | {
      ok: true
      /** Saved through the normal project update, so the window and the move fence see it. */
      preference: LocalWindowsRuntimePreference
      alignedLineEndingRepoIds: string[]
    }
  | { ok: false; blockers: WslDriveProjectBlocker[] }
