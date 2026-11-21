import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { basename, getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { editorTabFileAccess } from '@/lib/files/access/local-file-access'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import { runtimePathsExist } from '@/runtime/files/metadata/runtime-path-existence-batch'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import {
  listRuntimeFiles,
  searchRuntimeFilePaths
} from '@/runtime/files/search/runtime-file-search-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ImportNavigationFileAccess } from './import-navigation-file-access'

// Cmd-hover re-asks per pointer move; reuse host answers briefly instead of re-reading each time.
const HOST_ANSWER_TTL_MS = 4_000

export type ImportNavigationSourceFile = Pick<
  OpenFile,
  | 'id'
  | 'filePath'
  | 'relativePath'
  | 'worktreeId'
  | 'runtimeEnvironmentId'
  | 'externalSshTargetId'
  | 'readOnly'
  | 'liveTail'
>

/** The worktree root a tab's paths are relative to; null for files opened outside one. */
export function importNavigationRootOf(file: ImportNavigationSourceFile): string | null {
  if (!file.relativePath || file.relativePath === file.filePath) {
    return null
  }
  const root = file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1)
  return root && getRelativePathInsideRoot(file.filePath, root) !== null ? root : null
}

type Cached<Value> = { expiresAt: number; value: Promise<Value> }

const MAX_CACHED_ANSWERS = 512

function liveEntry<Value>(cache: Map<string, Cached<Value>>, key: string): Promise<Value> | null {
  const hit = cache.get(key)
  return hit && hit.expiresAt > Date.now() ? hit.value : null
}

function remember<Value>(
  cache: Map<string, Cached<Value>>,
  key: string,
  value: Promise<Value>
): void {
  if (cache.size >= MAX_CACHED_ANSWERS) {
    const now = Date.now()
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(entryKey)
      }
    }
  }
  cache.set(key, { expiresAt: Date.now() + HOST_ANSWER_TTL_MS, value })
}

const existenceCache = new Map<string, Cached<boolean>>()
const textCache = new Map<string, Cached<string | null>>()
const searchCache = new Map<string, Cached<string[]>>()
const MAX_NAMED_FILES = 200

function ownerKey(target: RuntimeClientTarget, file: ImportNavigationSourceFile): string {
  return JSON.stringify([target, file.worktreeId, file.externalSshTargetId ?? null])
}

/** Reads through the tab's owning host (local, SSH or runtime server), never the focused one. */
export function createOpenFileImportNavigationAccess(
  state: AppState,
  file: ImportNavigationSourceFile
): ImportNavigationFileAccess | null {
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  const rootPath = importNavigationRootOf(file)
  if (!target || !rootPath) {
    return null
  }
  const connectionId = getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
  const owner = ownerKey(target, file)
  const context = { target, worktreeId: file.worktreeId, worktreePath: rootPath, connectionId }

  const readText = async (path: string): Promise<string | null> => {
    const relativePath = getRelativePathInsideRoot(path, rootPath)
    if (relativePath === null) {
      return null
    }
    try {
      const result = await readRuntimeFileContent({
        target,
        filePath: path,
        relativePath,
        worktreeId: file.worktreeId,
        connectionId,
        expectedExternalSshTargetId: file.externalSshTargetId,
        access: editorTabFileAccess(state, { ...file, filePath: path, relativePath })
      })
      return result.isBinary ? null : result.content
    } catch {
      return null
    }
  }

  const findFilesNamed = async (fileName: string): Promise<string[]> => {
    try {
      // Why: local hosts filter by name while listing; SSH and runtime hosts search paths instead.
      const relativePaths =
        target.kind !== 'environment' && !connectionId
          ? await listRuntimeFiles(context, {
              rootPath,
              nameFilter: fileName,
              maxResults: MAX_NAMED_FILES
            })
          : (await searchRuntimeFilePaths(context, { query: fileName, limit: MAX_NAMED_FILES }))
              .files
      return relativePaths
        .filter((relativePath) => basename(relativePath) === fileName)
        .map((relativePath) => joinPath(rootPath, relativePath))
    } catch {
      return []
    }
  }

  return {
    findFilesNamed(fileName) {
      const key = `${owner}\0${fileName}`
      const hit = liveEntry(searchCache, key)
      if (hit) {
        return hit
      }
      const value = findFilesNamed(fileName)
      remember(searchCache, key, value)
      return value
    },
    pathsExist(paths) {
      const keyOf = (path: string): string => `${owner}\0${path}`
      const missing = paths.filter((path) => liveEntry(existenceCache, keyOf(path)) === null)
      if (missing.length > 0) {
        // Why: one batch per click; remote hosts answer every candidate in a single round trip.
        const batch = runtimePathsExist(context, [...missing]).then(
          (rows) => rows.map((row) => 'exists' in row && row.exists),
          () => missing.map(() => false)
        )
        missing.forEach((path, index) =>
          remember(
            existenceCache,
            keyOf(path),
            batch.then((rows) => rows[index] === true)
          )
        )
      }
      return Promise.all(
        paths.map((path) => liveEntry(existenceCache, keyOf(path)) ?? Promise.resolve(false))
      )
    },
    readText(path) {
      const key = `${owner}\0${path}`
      const hit = liveEntry(textCache, key)
      if (hit) {
        return hit
      }
      const value = readText(path)
      remember(textCache, key, value)
      return value
    }
  }
}
