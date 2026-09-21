import { dirname } from '@/lib/path'
import { isRuntimePathAbsolute, resolveRuntimePath } from '../../../../shared/cross-platform-path'

export type NodeModulesCandidatePath = {
  filePath: string
  relativePath: string
}

export type InstalledPackageVersionResult =
  | { status: 'installed'; version: string }
  | { status: 'not-installed' }

function walkRelativeDirsToRoot(relativeDir: string): string[] {
  // An absolute dir means the file is outside the worktree (tab-create-entry-absolute-file
  // falls back to the absolute path when relativization fails). Its ancestors would resolve
  // outside the root, and the root's own node_modules holds an unrelated project's version.
  if (isRuntimePathAbsolute(relativeDir)) {
    return []
  }
  const dirs: string[] = []
  let current = relativeDir === '.' ? '' : relativeDir
  dirs.push(current)
  while (current !== '') {
    const parent = dirname(current)
    // Stop where dirname stops making progress: every filesystem root ('/', 'C:\') is its
    // own parent, so a path that never reduces to '' would otherwise loop forever.
    if (parent === current) {
      break
    }
    current = parent === '.' ? '' : parent
    dirs.push(current)
  }
  return dirs
}

/**
 * Node module resolution, nearest-first: `<dir>/node_modules/<pkg>`, then
 * each ancestor up to (and including) the worktree root. Never walks above
 * the root — the caller stops there per the worktree-safety rule. A file
 * outside the worktree (absolute `relativePath`) yields no candidate at all.
 */
export function buildNodeModulesCandidatePaths(
  worktreeRoot: string,
  relativePath: string,
  packageName: string
): NodeModulesCandidatePath[] {
  return walkRelativeDirsToRoot(dirname(relativePath)).map((dir) => {
    const relative =
      dir === ''
        ? `node_modules/${packageName}/package.json`
        : `${dir}/node_modules/${packageName}/package.json`
    return { filePath: resolveRuntimePath(worktreeRoot, relative), relativePath: relative }
  })
}

function parsePackageJsonVersionField(content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    return null
  }
  return typeof parsed.version === 'string' ? parsed.version : null
}

/**
 * Reads the installed version by hoisting up from the hovered file's
 * directory to the worktree root, first hit wins. A read failure (ENOENT, a
 * remote read error, a binary/oversized guard) is normalized to "keep
 * walking", never a thrown error — the caller always gets a definite result.
 */
export async function resolveInstalledPackageVersion(params: {
  worktreeRoot: string
  relativePath: string
  packageName: string
  readCandidate: (candidate: NodeModulesCandidatePath) => Promise<string>
}): Promise<InstalledPackageVersionResult> {
  const candidates = buildNodeModulesCandidatePaths(
    params.worktreeRoot,
    params.relativePath,
    params.packageName
  )
  for (const candidate of candidates) {
    let content: string
    try {
      content = await params.readCandidate(candidate)
    } catch {
      continue
    }
    const version = parsePackageJsonVersionField(content)
    if (version) {
      return { status: 'installed', version }
    }
  }
  return { status: 'not-installed' }
}
