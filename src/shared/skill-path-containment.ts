import { posix, win32 } from 'node:path'

/**
 * Path semantics of the host that owns the files, which is not always the host
 * running this process: a WSL runtime is POSIX and case-sensitive while the
 * process platform is `win32`, and a remote Orca runtime has its own platform.
 */
export type SkillPathSemantics = { caseSensitive: boolean; sep: '/' | '\\' }

export const POSIX_SKILL_PATH_SEMANTICS: SkillPathSemantics = { caseSensitive: true, sep: '/' }
export const WINDOWS_SKILL_PATH_SEMANTICS: SkillPathSemantics = { caseSensitive: false, sep: '\\' }

/** Semantics of the process's own filesystem. */
export function nativeSkillPathSemantics(
  platform: NodeJS.Platform = process.platform
): SkillPathSemantics {
  return platform === 'win32' ? WINDOWS_SKILL_PATH_SEMANTICS : POSIX_SKILL_PATH_SEMANTICS
}

function pathApi(semantics: SkillPathSemantics): typeof posix {
  return semantics.sep === '\\' ? win32 : posix
}

function comparable(path: string, semantics: SkillPathSemantics): string {
  const resolved = pathApi(semantics).resolve(path)
  return semantics.caseSensitive ? resolved : resolved.toLocaleLowerCase('en-US')
}

export function normalizedSkillPath(path: string, semantics: SkillPathSemantics): string {
  return comparable(path, semantics)
}

export function skillPathsEqual(
  left: string,
  right: string,
  semantics: SkillPathSemantics
): boolean {
  return comparable(left, semantics) === comparable(right, semantics)
}

/** True when `path` sits strictly below `root`; the root itself is not inside. */
export function skillPathInside(
  root: string,
  path: string,
  semantics: SkillPathSemantics
): boolean {
  return relativeInside(root, path, semantics) !== null
}

/** Segment count of `path` below `root`; null when `path` is not inside `root`. */
export function skillPathDepthBelow(
  root: string,
  path: string,
  semantics: SkillPathSemantics
): number | null {
  const child = relativeInside(root, path, semantics)
  return child === null ? null : child.split(semantics.sep).length
}

function relativeInside(root: string, path: string, semantics: SkillPathSemantics): string | null {
  const api = pathApi(semantics)
  const child = api.relative(comparable(root, semantics), comparable(path, semantics))
  if (
    child === '' ||
    child === '..' ||
    child.startsWith(`..${semantics.sep}`) ||
    api.isAbsolute(child)
  ) {
    return null
  }
  return child
}
