import type { FilesystemApi } from '../../../preload/api/filesystem/filesystem-api'
import type { RuntimeFileReadChunkResult } from '../../../shared/file-content/runtime-file-read'
import type { DirEntry } from '../../../shared/file-listing/directory-entry'
import type { SearchResult } from '../../../shared/file-search/code-search-types'
import type { FsChangedPayload } from '../../../shared/file-watch/filesystem-change-event'
import { invokeNative, listenNative } from './tauri-native-host'

export type NativeFilesystemFallback = Pick<
  FilesystemApi['fs'],
  | 'readDir'
  | 'readFile'
  | 'readFileChunk'
  | 'stat'
  | 'pathExists'
  | 'listFiles'
  | 'search'
  | 'watchWorktree'
  | 'unwatchWorktree'
>

/** Native local filesystem read, search, and watch overrides for Tauri. */
export function createTauriNativeFilesystemReadApi(
  fallback?: NativeFilesystemFallback
): Partial<FilesystemApi['fs']> {
  return {
    readFile: async (args) => {
      if (
        (args.connectionId ||
          args.wakeWslDistro ||
          args.rangePreview ||
          args.includeLocalLogMetadata) &&
        fallback
      ) {
        return fallback.readFile(args)
      }
      return invokeNative('poc_read_file', {
        args: { filePath: args.filePath }
      })
    },
    readFileChunk: async (args) => {
      if ((args.connectionId || args.wakeWslDistro) && fallback) {
        return fallback.readFileChunk(args)
      }
      return invokeNative<RuntimeFileReadChunkResult>('poc_read_file_chunk', {
        args: {
          filePath: args.filePath,
          offset: args.offset,
          length: args.length
        }
      })
    },
    stat: async (args) => {
      if ((args.connectionId || args.wakeWslDistro) && fallback) {
        return fallback.stat(args)
      }
      return invokeNative('poc_stat', {
        args: { filePath: args.filePath }
      })
    },
    pathExists: async (args) => {
      if (args.connectionId && fallback) {
        return fallback.pathExists(args)
      }
      return invokeNative<boolean>('poc_path_exists', { path: args.filePath })
    },
    watchWorktree: async (args) => {
      if (args.connectionId && fallback) {
        return fallback.watchWorktree(args)
      }
      await invokeNative('poc_watch_worktree', { worktreePath: args.worktreePath })
    },
    unwatchWorktree: async (args) => {
      if (args.connectionId && fallback) {
        return fallback.unwatchWorktree(args)
      }
      await invokeNative('poc_unwatch_worktree', { worktreePath: args.worktreePath })
    },
    onFsChanged: (callback) => listenNative<FsChangedPayload>('fs:changed', callback),
    readDir: async (args) => {
      if ((args.connectionId || args.wakeWslDistro) && fallback) {
        return fallback.readDir(args)
      }
      return invokeNative<DirEntry[]>('poc_read_dir', {
        args: {
          dirPath: args.dirPath,
          followSymlinks: args.followSymlinks
        }
      })
    },
    listFiles: async (args) => {
      if (args.connectionId && fallback) {
        return fallback.listFiles(args)
      }
      return invokeNative<string[]>('poc_list_files', {
        args: {
          rootPath: args.rootPath,
          excludePaths: args.excludePaths,
          maxResults: args.maxResults,
          searchQuery: args.searchQuery,
          candidatePaths: args.candidatePaths,
          includeIgnored: args.includeIgnored,
          followSymlinks: args.followSymlinks,
          nameFilter: args.nameFilter
        }
      })
    },
    search: async (args) => {
      if (args.connectionId && fallback) {
        return fallback.search(args)
      }
      return invokeNative<SearchResult>('poc_search_files', {
        args: {
          query: args.query,
          rootPath: args.rootPath,
          caseSensitive: args.caseSensitive,
          wholeWord: args.wholeWord,
          useRegex: args.useRegex,
          includePattern: args.includePattern,
          excludePattern: args.excludePattern,
          maxResults: args.maxResults
        }
      })
    }
  }
}
