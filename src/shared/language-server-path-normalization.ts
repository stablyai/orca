// Canonical file identity for native-host language-server navigation. Spec D5:
// one normalize rule shared by the renderer (model keys, IPC payloads), the
// main process (document table, session routing) and the URI round trip.
//
// The rule exists because `Uri.file().fsPath` lowercases the Windows drive
// letter, so without normalization the same file reaches the session under two
// keys (`D:\a.c` vs `d:\a.c`). POSIX native paths are already canonical and
// pass through untouched.
//
// WSL UNC paths (`\\wsl.localhost\<distro>\…`): Monaco's `Uri.file().fsPath`
// normalizes a UNC input to backslashes, but a path assembled from a guest
// POSIX HOME (forward slashes) or a guest-returned location can arrive with
// mixed separators. The renderer doc-sync bridge compares the model's fsPath
// against the open tab's filePath through this function, so a UNC path that
// keeps its forward slashes never matches its backslash-normalized model and
// the document never didOpens (the host abstraction's WSL seam — ticket 16).
// Fold every WSL UNC to backslashes here so the renderer key is stable across
// separator spellings; the main process re-folds (case + separators) via
// `wslNormalizeKey`, and filesystem ops accept the canonical backslash UNC.
//
// SSH remote POSIX paths: on a Windows client, `Uri.file().fsPath` rewrites a
// `file:///home/zwf/a.cpp` to backslashes (`\home\zwf\a.cpp`) — the store tab
// keeps the guest POSIX spelling (`/home/zwf/a.cpp`), so without folding here
// the model key never matches its open tab and the document never didOpens
// (the SSH project-host LSP seam). A single backslash-led absolute path that
// is not a UNC is a POSIX path mis-spelled by the Windows fsPath layer, so
// fold it back to forward slashes.
import { isWslUncPath } from './wsl-paths'

function isWindowsDrivePath(filePath: string): boolean {
  return /^[a-zA-Z]:/.test(filePath)
}

/** True for a single-backslash-led absolute path (NOT a `\\` UNC) — a POSIX
 *  path that Windows `Uri.file().fsPath` re-spelled with backslashes. */
function isMisSpelledPosixAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('\\') && !filePath.startsWith('\\\\')
}

/**
 * Canonical map key for a native path. Windows drive paths get an uppercased
 * drive letter + backslashes; WSL UNC paths get backslashes (so a path built
 * from a guest POSIX home matches its Monaco-normalized model fsPath); a
 * single-backslash-led absolute path (an SSH POSIX path re-spelled by the
 * Windows fsPath layer) folds back to forward slashes to match the store's
 * POSIX spelling; other POSIX paths pass through untouched.
 */
export function normalizeNativeFilePath(filePath: string): string {
  if (isWindowsDrivePath(filePath)) {
    const withBackslashes = filePath.replace(/\//g, '\\')
    return withBackslashes[0].toUpperCase() + withBackslashes.slice(1)
  }
  if (isWslUncPath(filePath) && filePath.includes('/')) {
    return filePath.replace(/\//g, '\\')
  }
  if (isMisSpelledPosixAbsolutePath(filePath)) {
    return filePath.replace(/\\/g, '/')
  }
  return filePath
}

export function isWindowsNativePath(filePath: string): boolean {
  return isWindowsDrivePath(filePath)
}
