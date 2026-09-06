/**
 * Whether node-pty execs its `spawn-helper` binary on a platform.
 *
 * Only macOS: binding.gyp declares the `spawn-helper` target inside `OS=="mac"`, and
 * `src/unix/pty.cc` reads the helper path only under `#if defined(__APPLE__)`. Every
 * other platform forks directly, so requiring the helper there calls a working host
 * broken.
 */
export function usesNodePtySpawnHelper(platform: string): boolean {
  return platform === 'darwin'
}
