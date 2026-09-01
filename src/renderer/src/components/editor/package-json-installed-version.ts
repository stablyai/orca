import { dirname } from '@/lib/path'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'

export type NodeModulesCandidatePath = {
  filePath: string
  relativePath: string
}

export type InstalledPackageVersionResult =
  | { status: 'installed'; version: string }
  | { status: 'not-installed' }

function walkRelativeDirsToRoot(relativeDir: string): string[] {
  const dirs: string[] = []
  let current = relativeDir === '.' ? '' : relativeDir
  dirs.push(current)
  while (current !== '') {
    const parent = dirname(current)
    current = parent === '.' ? '' : parent
    dirs.push(current)
  }
  return dirs
}

/**
 * Node module resolution, nearest-first: `<dir>/node_modules/<pkg>`, then
 * each ancestor up to (and including) the worktree root. Never walks above
 * the root — the caller stops there per the worktree-safety rule.
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
  try {
    const parsed = JSON.parse(content) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
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
