import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import {
  readRuntimeFilePreview,
  runtimePathExists,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getTerminalFileContext,
  openDetectedFilePath
} from '../terminal-pane/terminal-file-open-routing'
import {
  buildImportTargetCandidates,
  isRelativeSpecifier,
  type ImportSpecifierLink
} from './import-specifier-links'
import { parseTsconfigPathAliases, type TsconfigPathAliases } from './tsconfig-path-aliases'

export type ResolvedImportLinkTarget = {
  specifier: string
  targetPath: string
  // Worktree-relative when possible, so link labels stay short.
  targetLabel: string
  lineNumber: number
  column: number
}

export type ImportLinkSource = {
  filePath: string
  fileId: string
  worktreeId: string | undefined
}

type CachedTsconfigAliases = { loadedAtMs: number; aliases: Promise<TsconfigPathAliases | null> }

const tsconfigAliasCache = new Map<string, CachedTsconfigAliases>()
const TSCONFIG_ALIAS_CACHE_TTL_MS = 30_000

async function readTsconfigAliases(
  fileContext: RuntimeFileOperationArgs,
  worktreeRoot: string
): Promise<TsconfigPathAliases | null> {
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const result = await readRuntimeFilePreview(fileContext, joinPath(worktreeRoot, configName))
      if (result.isBinary) {
        continue
      }
      const aliases = parseTsconfigPathAliases(result.content)
      if (aliases) {
        return aliases
      }
    } catch {
      // Missing or unreadable config — fall through to the next candidate.
    }
  }
  return null
}

function loadTsconfigAliases(
  fileContext: RuntimeFileOperationArgs,
  worktreeId: string,
  worktreeRoot: string
): Promise<TsconfigPathAliases | null> {
  const cacheKey = `${worktreeId} ${worktreeRoot}`
  const cached = tsconfigAliasCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.loadedAtMs < TSCONFIG_ALIAS_CACHE_TTL_MS) {
    return cached.aliases
  }
  const aliases = readTsconfigAliases(fileContext, worktreeRoot)
  tsconfigAliasCache.set(cacheKey, { loadedAtMs: now, aliases })
  return aliases
}

async function findFirstExistingFile(
  fileContext: RuntimeFileOperationArgs,
  candidates: string[]
): Promise<string | null> {
  // Why: probe with pathExists, not stat — most candidates are misses and a
  // failed fs:stat logs an ENOENT error in the main process for every probe.
  // Probes run concurrently so SSH round-trips don't serialize, but the pick
  // still honors candidate order (`.ts` beats `/index.js`).
  const exists = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return await runtimePathExists(fileContext, candidate)
      } catch {
        return false
      }
    })
  )
  for (let index = 0; index < candidates.length; index += 1) {
    if (!exists[index]) {
      continue
    }
    // Stat only confirmed hits (no ENOENT noise) to skip directories, e.g. a
    // bare `components/Badge` dir must lose to `components/Badge/index.tsx`.
    try {
      const stat = await statRuntimePath(fileContext, candidates[index])
      if (!stat.isDirectory) {
        return candidates[index]
      }
    } catch {
      // Raced deletion — try the next candidate.
    }
  }
  return null
}

type ImportOpenContext = {
  worktreeId: string
  worktreeRoot: string | null
  runtimeEnvironmentId: string | null | undefined
  fileContext: RuntimeFileOperationArgs
}

function getImportOpenContext(worktreeId: string | undefined, fileId: string): ImportOpenContext {
  const state = useAppStore.getState()
  const resolvedWorktreeId = worktreeId ?? ''
  const worktree = resolvedWorktreeId
    ? findWorktreeById(state.worktreesByRepo, resolvedWorktreeId)
    : undefined
  const runtimeEnvironmentId = state.openFiles.find(
    (file) => file.id === fileId
  )?.runtimeEnvironmentId
  const worktreeRoot = worktree?.path ?? null
  return {
    worktreeId: resolvedWorktreeId,
    worktreeRoot,
    runtimeEnvironmentId,
    fileContext: getTerminalFileContext(
      resolvedWorktreeId,
      worktreeRoot ?? '',
      runtimeEnvironmentId
    )
  }
}

export async function resolveImportLinkTarget(
  link: ImportSpecifierLink,
  source: ImportLinkSource
): Promise<ResolvedImportLinkTarget | null> {
  const { worktreeId, worktreeRoot, fileContext } = getImportOpenContext(
    source.worktreeId,
    source.fileId
  )
  const aliases =
    !isRelativeSpecifier(link.specifier) && worktreeRoot
      ? await loadTsconfigAliases(fileContext, worktreeId, worktreeRoot)
      : null
  const candidates = buildImportTargetCandidates(
    link.specifier,
    source.filePath,
    worktreeRoot,
    aliases
  )
  if (candidates.length === 0) {
    return null
  }
  const targetPath = await findFirstExistingFile(fileContext, candidates)
  if (!targetPath) {
    return null
  }
  return {
    specifier: link.specifier,
    targetPath,
    targetLabel: getRelativePathInsideRoot(targetPath, worktreeRoot) ?? targetPath,
    lineNumber: link.range.startLineNumber,
    column: link.range.startColumn
  }
}

export function openImportFileTarget(
  targetPath: string,
  ids: { worktreeId: string | undefined; fileId: string }
): void {
  const { worktreeId, worktreeRoot, runtimeEnvironmentId } = getImportOpenContext(
    ids.worktreeId,
    ids.fileId
  )
  openDetectedFilePath(targetPath, null, null, {
    worktreeId,
    worktreePath: worktreeRoot ?? '',
    runtimeEnvironmentId
  })
}
