import { joinPath } from '@/lib/path'
import { getExternalFileChangeRelativePath } from '@/components/right-sidebar/useFileExplorerWatch'
import type { OpenFile } from '@/store/slices/editor'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  getLocalWindowsWslPathIdentity,
  normalizeRuntimePathForComparison,
  type LocalWindowsWslPathIdentity
} from '../../../../shared/cross-platform-path'

type WatchScope = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  allowLocalWindowsWslAliases?: true
}

type IndexedPath = {
  absolutePath: string
  identity: LocalWindowsWslPathIdentity
}

type IndexedOpenFile = {
  file: OpenFile
  index: number
  identity: LocalWindowsWslPathIdentity | null
}

export type IndexedExternalWatchChange = IndexedPath & {
  relativePath: string
}

export type EditorExternalWatchBatchPathIndex = {
  createOrUpdatePaths: ReadonlyMap<string, string>
  changes: readonly IndexedExternalWatchChange[]
  deletedOpenEditors: readonly { file: OpenFile; normalizedDeletePath: string }[]
  hasCombinedDiffConsumer: boolean
  matchesCreateOrUpdate: (file: OpenFile) => boolean
  matchingOpenFiles: (
    change: IndexedExternalWatchChange,
    currentOpenFiles?: OpenFile[]
  ) => OpenFile[]
}

function openFileRuntimeOwner(file: Pick<OpenFile, 'runtimeEnvironmentId'>): string | null {
  return file.runtimeEnvironmentId?.trim() || null
}

function addToListMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) {
    existing.push(value)
  } else {
    map.set(key, [value])
  }
}

class IndexedPathLookup<T> {
  private readonly direct = new Map<string, T>()
  private readonly aliases = new Map<string, T>()
  private readonly wslAliases = new Map<string, T>()

  constructor(private readonly allowAliases: boolean) {}

  add(path: IndexedPath, value: T): void {
    this.direct.set(path.identity.normalizedPath, value)
    if (!this.allowAliases) {
      return
    }
    this.aliases.set(path.identity.aliasComparisonPath, value)
    if (path.identity.isWslUnc) {
      this.wslAliases.set(path.identity.aliasComparisonPath, value)
    }
  }

  get(identity: LocalWindowsWslPathIdentity): T | undefined {
    const direct = this.direct.get(identity.normalizedPath)
    if (direct !== undefined || !this.allowAliases) {
      return direct
    }
    return identity.isWslUnc
      ? this.aliases.get(identity.aliasComparisonPath)
      : this.wslAliases.get(identity.aliasComparisonPath)
  }
}

function pathIdentity(value: string, allowAliases: boolean): LocalWindowsWslPathIdentity {
  if (allowAliases) {
    return getLocalWindowsWslPathIdentity(value)
  }
  const normalizedPath = normalizeRuntimePathForComparison(value)
  return { normalizedPath, aliasComparisonPath: normalizedPath, isWslUnc: false }
}

function collectMatchingFiles(
  direct: readonly IndexedOpenFile[],
  aliases: readonly IndexedOpenFile[],
  diffs: readonly IndexedOpenFile[]
): OpenFile[] {
  const byIndex = new Map<number, OpenFile>()
  for (const entry of [...direct, ...aliases, ...diffs]) {
    byIndex.set(entry.index, entry.file)
  }
  return [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, file]) => file)
}

class IndexedOpenFileLookup {
  private readonly directEditors = new Map<string, IndexedOpenFile[]>()
  private readonly aliasEditors = new Map<string, IndexedOpenFile[]>()
  private readonly wslAliasEditors = new Map<string, IndexedOpenFile[]>()
  private readonly diffsByRelativePath = new Map<string, IndexedOpenFile[]>()
  readonly indexedOpenFiles = new Map<string, IndexedOpenFile>()
  readonly hasCombinedDiffConsumer: boolean

  constructor(
    openFiles: OpenFile[],
    scope: WatchScope,
    private readonly allowAliases: boolean
  ) {
    let hasCombinedDiffConsumer = false
    for (const [index, file] of openFiles.entries()) {
      if (
        file.worktreeId !== scope.worktreeId ||
        openFileRuntimeOwner(file) !== scope.runtimeEnvironmentId
      ) {
        continue
      }
      if (
        file.mode === 'diff' &&
        (file.diffSource === 'combined-uncommitted' || file.diffSource === 'combined-all')
      ) {
        hasCombinedDiffConsumer = true
        continue
      }
      if (file.mode === 'diff') {
        if (file.diffSource === 'unstaged' || file.diffSource === 'staged') {
          addToListMap(this.diffsByRelativePath, file.relativePath, {
            file,
            index,
            identity: null
          })
        }
        continue
      }
      if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
        continue
      }
      const identity = pathIdentity(file.filePath, allowAliases)
      const indexedFile = { file, index, identity }
      this.indexedOpenFiles.set(file.id, indexedFile)
      addToListMap(this.directEditors, file.filePath, indexedFile)
      if (allowAliases) {
        addToListMap(this.aliasEditors, identity.aliasComparisonPath, indexedFile)
        if (identity.isWslUnc) {
          addToListMap(this.wslAliasEditors, identity.aliasComparisonPath, indexedFile)
        }
      }
    }
    this.hasCombinedDiffConsumer = hasCombinedDiffConsumer
  }

  matchingOpenFiles(change: IndexedExternalWatchChange): OpenFile[] {
    const aliases = !this.allowAliases
      ? []
      : change.identity.isWslUnc
        ? (this.aliasEditors.get(change.identity.aliasComparisonPath) ?? [])
        : (this.wslAliasEditors.get(change.identity.aliasComparisonPath) ?? [])
    return collectMatchingFiles(
      this.directEditors.get(change.absolutePath) ?? [],
      aliases,
      this.diffsByRelativePath.get(change.relativePath) ?? []
    )
  }
}

export function indexEditorExternalWatchBatchPaths(
  payload: FsChangedPayload,
  openFiles: OpenFile[],
  scope: WatchScope
): EditorExternalWatchBatchPathIndex {
  const allowAliases = scope.allowLocalWindowsWslAliases === true
  const createOrUpdateLookup = new IndexedPathLookup<IndexedPath>(allowAliases)
  const deleteLookup = new IndexedPathLookup<IndexedPath>(allowAliases)
  const createOrUpdatePaths = new Map<string, string>()
  const changesByRelativePath = new Map<string, IndexedExternalWatchChange>()

  for (const event of payload.events) {
    if (event.kind === 'overflow') {
      continue
    }
    const eventPath: IndexedPath = {
      absolutePath: event.absolutePath,
      identity: pathIdentity(event.absolutePath, allowAliases)
    }
    if (event.kind === 'delete') {
      deleteLookup.add(eventPath, eventPath)
      continue
    }
    if (event.isDirectory !== true) {
      createOrUpdatePaths.set(eventPath.identity.normalizedPath, event.absolutePath)
      createOrUpdateLookup.add(eventPath, eventPath)
    }
    const relativePath = getExternalFileChangeRelativePath(
      scope.worktreePath,
      event.absolutePath,
      event.isDirectory
    )
    if (relativePath && !changesByRelativePath.has(relativePath)) {
      const absolutePath = joinPath(scope.worktreePath, relativePath)
      changesByRelativePath.set(relativePath, {
        relativePath,
        absolutePath,
        identity: eventPath.identity
      })
    }
  }

  const initialOpenFileLookup = new IndexedOpenFileLookup(openFiles, scope, allowAliases)
  const openFileLookups = new WeakMap<OpenFile[], IndexedOpenFileLookup>()
  openFileLookups.set(openFiles, initialOpenFileLookup)
  const getOpenFileLookup = (currentOpenFiles: OpenFile[]): IndexedOpenFileLookup => {
    const existing = openFileLookups.get(currentOpenFiles)
    if (existing) {
      return existing
    }
    const indexed = new IndexedOpenFileLookup(currentOpenFiles, scope, allowAliases)
    openFileLookups.set(currentOpenFiles, indexed)
    return indexed
  }
  const matchesCreateOrUpdate = (file: OpenFile): boolean => {
    const identity =
      initialOpenFileLookup.indexedOpenFiles.get(file.id)?.identity ??
      pathIdentity(file.filePath, allowAliases)
    return createOrUpdateLookup.get(identity) !== undefined
  }
  const deletedOpenEditors: { file: OpenFile; normalizedDeletePath: string }[] = []
  for (const indexedFile of initialOpenFileLookup.indexedOpenFiles.values()) {
    const deletedPath = deleteLookup.get(indexedFile.identity!)
    if (deletedPath) {
      deletedOpenEditors.push({
        file: indexedFile.file,
        normalizedDeletePath: deletedPath.identity.normalizedPath
      })
    }
  }

  return {
    createOrUpdatePaths,
    changes: [...changesByRelativePath.values()],
    deletedOpenEditors,
    hasCombinedDiffConsumer: initialOpenFileLookup.hasCombinedDiffConsumer,
    matchesCreateOrUpdate,
    matchingOpenFiles: (change, currentOpenFiles = openFiles) =>
      getOpenFileLookup(currentOpenFiles).matchingOpenFiles(change)
  }
}
