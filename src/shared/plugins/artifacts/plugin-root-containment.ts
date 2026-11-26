import { isAbsolute, relative, sep } from 'node:path'

/** A real path strictly inside the plugin's real root, relative to it; null when outside,
 *  including on another Windows drive, where `relative` returns an absolute path. */
export function pathInsidePluginRoot(rootReal: string, artifactReal: string): string | null {
  const fromRoot = relative(rootReal, artifactReal)
  return fromRoot.length > 0 &&
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`)
    ? fromRoot
    : null
}
