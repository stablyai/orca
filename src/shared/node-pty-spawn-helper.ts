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

/**
 * node-pty's per-ABI build dir, which the patched loader tries before build/Release. Matches
 * config/scripts/native-build-entry.cjs; only dev installs sharing a package dir have it.
 */
export function nodePtyNativeBuildEntryDir(platform: string, arch: string): string {
  return `build/orca-napi-${platform}-${arch}`
}
