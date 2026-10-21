/**
 * The pinned Node a Linux AppImage carries, so what runs outside Electron needs no download.
 * deb and rpm exclude it at packaging time: their installs never vanish under a running process.
 *
 * Keep this file erasable-only TypeScript with no imports — packaging scripts require it directly.
 */

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
