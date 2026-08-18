import type { Stats } from 'node:fs'
import { win32 } from 'node:path'
import { isCursorSidecarScanCancelledError } from './cursor-sidecar-scan-cancellation'

type LstatPath = (path: string) => Promise<Stats>

export function isCursorMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function isConfirmedCursorPathMissing(
  path: string,
  error: unknown,
  lstatPath: LstatPath
): Promise<boolean> {
  if (!isCursorMissingPathError(error)) {
    return false
  }
  const uncRoot = win32.parse(path).root
  if (!uncRoot.replaceAll('/', '\\').startsWith('\\\\')) {
    return true
  }

  let ancestor = win32.dirname(path)
  for (;;) {
    if (win32.parse(ancestor).root.toLowerCase() !== uncRoot.toLowerCase()) {
      return false
    }
    try {
      await lstatPath(ancestor)
      return true
    } catch (ancestorError) {
      if (
        isCursorSidecarScanCancelledError(ancestorError) ||
        (ancestorError instanceof Error && ancestorError.name === 'AbortError')
      ) {
        throw ancestorError
      }
      if (!isCursorMissingPathError(ancestorError)) {
        return false
      }
    }
    const parent = win32.dirname(ancestor)
    if (parent === ancestor) {
      return false
    }
    ancestor = parent
  }
}
