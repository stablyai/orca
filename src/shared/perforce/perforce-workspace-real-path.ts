import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { resolveInWorkspace } from './perforce-arguments'

function isInsideRealRoot(realRoot: string, realPath: string): boolean {
  const inside = relative(realRoot, realPath)
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/**
 * `filePath` inside `cwd` with its folder resolved through links, for deleting it: a linked folder
 * in the workspace must not carry the delete outside. Null when the folder does not exist.
 */
export async function resolveDeletableInWorkspace(
  cwd: string,
  filePath: string
): Promise<string | null> {
  const absolute = resolveInWorkspace(cwd, filePath)
  const [realRoot, realParent] = await Promise.all([
    realpathOrNull(cwd),
    realpathOrNull(dirname(absolute))
  ])
  if (!realRoot || !realParent) {
    return null
  }
  if (!isInsideRealRoot(realRoot, realParent)) {
    throw new Error('Perforce file path escapes the workspace')
  }
  // Why the parent only: deleting a link removes the link itself, never what it points to.
  return join(realParent, basename(absolute))
}

/** `filePath` inside `cwd` resolved through every link, for reading it; null when it is missing or lands outside. */
export async function resolveReadableInWorkspace(
  cwd: string,
  filePath: string
): Promise<string | null> {
  const absolute = resolveInWorkspace(cwd, filePath)
  const [realRoot, realFile] = await Promise.all([realpathOrNull(cwd), realpathOrNull(absolute)])
  return realRoot && realFile && isInsideRealRoot(realRoot, realFile) ? realFile : null
}
