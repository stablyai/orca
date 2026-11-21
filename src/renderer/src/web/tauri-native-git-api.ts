import type { PreloadApi } from '../../../preload/api-types'
import type { GitDiffResult } from '../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusResult } from '../../../shared/git/status/git-status-types'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

type NativeGitFallback = Pick<PreloadApi['git'], 'status' | 'diff' | 'checkIgnored'>

/** Native git inspection overrides for local repositories in Tauri. */
export function createTauriNativeGitApi(fallback?: NativeGitFallback): Partial<PreloadApi['git']> {
  if (!isTauriNativeHost()) {
    return {}
  }
  return {
    status: async (args) => {
      if ((args.connectionId || args.wakeWslDistro || args.branchLineTotalMergeBase) && fallback) {
        return fallback.status(args)
      }
      return invokeNative<GitStatusResult>('poc_git_status', {
        args: {
          worktreePath: args.worktreePath,
          includeIgnored: args.includeIgnored,
          includeLineStats: args.includeLineStats
        }
      })
    },
    diff: async (args) => {
      if ((args.connectionId || args.wakeWslDistro) && fallback) {
        return fallback.diff(args)
      }
      return invokeNative<GitDiffResult>('poc_git_diff', {
        args: {
          worktreePath: args.worktreePath,
          filePath: args.filePath,
          staged: args.staged,
          compareAgainstHead: args.compareAgainstHead,
          oldPath: args.oldPath
        }
      })
    },
    checkIgnored: async (args) => {
      if (args.connectionId && fallback) {
        return fallback.checkIgnored(args)
      }
      return invokeNative<string[]>('poc_git_check_ignored', {
        args: {
          worktreePath: args.worktreePath,
          paths: args.paths
        }
      })
    }
  }
}
