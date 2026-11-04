/** macOS alone uses spawn-helper: binding.gyp OS==mac and unix/pty.cc __APPLE__ guards. Other platforms fork directly;
 * requiring the helper there falsely marks working hosts broken. */
export function usesNodePtySpawnHelper(platform: string): boolean {
  return platform === 'darwin'
}

/** Per-platform/arch node-pty build slot tried before build/Release; matches config/scripts/native-build-entry.cjs for shared dev installs. */
export function nodePtyNativeBuildEntryDir(platform: string, arch: string): string {
  return `build/orca-napi-${platform}-${arch}`
}
