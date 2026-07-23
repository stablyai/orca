import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { parseWslUncPath, toWindowsWslPath, windowsPathFromWslMntPath } from './wsl-paths'

/** Resolve a linked worktree's `gitdir:` pointer against its checkout path. */
export function resolveGitDirPointerTarget(worktreePath: string, pointer: string): string {
  if (pointer.startsWith('/')) {
    // Why: a WSL checkout's pointer holds a Linux path; resolving it against the UNC
    // checkout would land on the local Windows drive. Map it through the checkout's distro.
    const wsl = parseWslUncPath(worktreePath)
    if (wsl) {
      return toWindowsWslPath(pointer, wsl.distro)
    }
    // Why: a drvfs checkout (git in WSL, repo on a Windows drive) writes a /mnt/<drive>
    // pointer while the checkout path is C:\...; map it drive-to-drive (distro-independent)
    // so the probe reads the real gitdir instead of a nonexistent C:\mnt\... resolve.
    const drvfsGitDir = windowsPathFromWslMntPath(pointer)
    if (drvfsGitDir && isWindowsAbsolutePathLike(worktreePath)) {
      return drvfsGitDir
    }
  }
  return path.resolve(worktreePath, pointer)
}

/**
 * Resolve a worktree's private git dir: `.git` itself, or the target of a linked
 * worktree's `gitdir:` pointer file. Pure fs (no git subprocess), so it is host
 * Git-version agnostic. Single resolver for the main and relay callers so their
 * on-disk state probes (conflict/rebase detection) cannot drift.
 */
export async function resolveWorktreeGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')
  try {
    const contents = await readFile(dotGitPath, 'utf-8')
    const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return resolveGitDirPointerTarget(worktreePath, match[1])
    }
  } catch {
    // `.git` is a directory in a primary checkout.
  }
  return dotGitPath
}
