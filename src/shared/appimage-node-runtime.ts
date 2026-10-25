/** Bundle pinned Node for AppImage processes outside Electron; deb/rpm omit it because installed runtimes persist. Keep import-free erasable TypeScript for direct packaging-script require. */

/** Segments under the app's resources dir, laid out like the upstream archive (`bin/node`). */
export const APPIMAGE_NODE_RUNTIME_SEGMENTS = ['node-runtime', 'bin', 'node'] as const
/** fpm `--exclude` pattern, matched against each staged path (`*` crosses `/` there). */
export const APPIMAGE_NODE_RUNTIME_FPM_EXCLUDE = '*/resources/node-runtime'

/** AppImages are glibc builds, so only a glibc host of the same CPU can use the bundled Node. */
export function appImageNodeRuntimeTarget(
  arch: string
): 'linux-x64-glibc' | 'linux-arm64-glibc' | null {
  if (arch === 'x64') {
    return 'linux-x64-glibc'
  }
  if (arch === 'arm64') {
    return 'linux-arm64-glibc'
  }
  return null
}
