// Canonical file identity for native-host language-server navigation. Spec D5:
// one normalize rule shared by the renderer (model keys, IPC payloads), the
// main process (document table, session routing) and the URI round trip.
//
// The rule exists because `Uri.file().fsPath` lowercases the Windows drive
// letter, so without normalization the same file reaches the session under two
// keys (`D:\a.c` vs `d:\a.c`). POSIX native paths are already canonical and
// pass through untouched.

function isWindowsDrivePath(filePath: string): boolean {
  return /^[a-zA-Z]:/.test(filePath)
}

/** Canonical map key for a native path: uppercase drive letter + backslashes. */
export function normalizeNativeFilePath(filePath: string): string {
  if (!isWindowsDrivePath(filePath)) {
    return filePath
  }
  const withBackslashes = filePath.replace(/\//g, '\\')
  return withBackslashes[0].toUpperCase() + withBackslashes.slice(1)
}

export function isWindowsNativePath(filePath: string): boolean {
  return isWindowsDrivePath(filePath)
}
