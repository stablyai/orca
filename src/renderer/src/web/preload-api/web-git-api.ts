import type { PreloadApi } from '../../../../preload/api-types'
import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment, updateEnvironmentFromResponse } from './web-runtime-session'
import {
  resolveRuntimeFilePath,
  resolveRuntimeWorktreeByPath
} from './web-runtime-worktree-catalog'

export const webGitStatusAbortControllers = new Map<string, AbortController>()

export async function callAbortableRuntimeStatus<TResult>(
  requestToken: string,
  params: unknown
): Promise<TResult> {
  const environment = requireActiveEnvironment()
  webGitStatusAbortControllers.get(requestToken)?.abort()
  const controller = new AbortController()
  webGitStatusAbortControllers.set(requestToken, controller)
  try {
    const response = await callAbortableRuntimeEnvironment(
      environment.id,
      'git.status',
      params,
      undefined,
      controller.signal
    )
    updateEnvironmentFromResponse(environment, response)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as TResult
  } finally {
    if (webGitStatusAbortControllers.get(requestToken) === controller) {
      webGitStatusAbortControllers.delete(requestToken)
    }
  }
}

export function createGitApi(): NonNullable<Partial<PreloadApi>['git']> {
  return {
    status: async ({
      worktreePath,
      includeIgnored,
      includeLineStats,
      bypassEffectiveUpstreamNegativeCache,
      reuseLineStats,
      branchLineTotalMergeBase,
      requestToken
    }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      const params = {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        includeIgnored,
        includeLineStats,
        bypassEffectiveUpstreamNegativeCache,
        reuseLineStats,
        ...(branchLineTotalMergeBase ? { branchLineTotalMergeBase } : {})
      }
      // Why: no token = nothing to cancel (pooled); a token routes via the subscription bridge so cancelStatus can abort.
      if (!requestToken) {
        return callRuntimeResult('git.status', params)
      }
      return callAbortableRuntimeStatus(requestToken, params)
    },
    cancelStatus: async ({ requestToken }) => {
      webGitStatusAbortControllers.get(requestToken)?.abort()
    },
    setStatusUpstreamRefWatch: async () => {},
    submoduleStatus: async ({ worktreePath, submodulePath, area }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.submoduleStatus', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        submodulePath,
        area
      })
    },
    checkIgnored: async ({ worktreePath, paths }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.checkIgnored', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        paths
      })
    },
    // Why: the "add huge folder to .gitignore" flow is desktop-only; the web runtime makes no offer, so return no candidates.
    findHugeFoldersToIgnore: async () => [],
    appendGitignore: async () => false,
    history: async ({ worktreePath, limit, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.history', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        limit,
        baseRef
      })
    },
    conflictOperation: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.conflictOperation', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    abortMerge: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortMerge', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    abortRebase: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortRebase', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    diff: async ({ worktreePath, filePath, staged, compareAgainstHead }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.diff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        staged,
        compareAgainstHead
      })
    },
    branchCompare: async ({ worktreePath, baseRef, admissionTier }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.branchCompare', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        baseRef,
        ...(admissionTier ? { admissionTier } : {})
      })
    },
    commitCompare: async ({ worktreePath, commitId }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commitCompare', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        commitId
      })
    },
    upstreamStatus: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.upstreamStatus', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    fetch: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fetch', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    syncFork: async ({ worktreePath, expectedUpstream }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult(
        'git.forkSync',
        {
          worktree: toRuntimeWorktreeSelector(worktree.id),
          expectedUpstream
        },
        60_000
      )
    },
    push: async ({ worktreePath, publish, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.push', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        publish,
        pushTarget
      })
    },
    pull: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.pull', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    fastForward: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fastForward', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    rebaseFromBase: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.rebaseFromBase', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        baseRef
      })
    },
    branchDiff: async ({ worktreePath, filePath, compare, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.branchDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        compare,
        oldPath
      })
    },
    commitDiff: async ({ worktreePath, filePath, commitOid, parentOid, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.commitDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        commitOid,
        parentOid,
        oldPath
      })
    },
    commit: async ({ worktreePath, message }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commit', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        message
      })
    },
    generateCommitMessage: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.9fc90740b6',
        'Commit message generation is unavailable in the web client.'
      )
    }),
    discoverCommitMessageModels: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.e57c82d276',
        'Commit message model discovery is unavailable in the web client.'
      )
    }),
    cancelGenerateCommitMessage: () => Promise.resolve(),
    generatePullRequestFields: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.b8a1618172',
        'Pull request detail generation is unavailable in the web client.'
      )
    }),
    cancelGeneratePullRequestFields: () => Promise.resolve(),
    stage: async ({ worktreePath, filePath }) => mutateGitPath('git.stage', worktreePath, filePath),
    bulkStage: async ({ worktreePath, filePaths }) =>
      mutateGitPaths('git.bulkStage', worktreePath, filePaths),
    unstage: async ({ worktreePath, filePath }) =>
      mutateGitPath('git.unstage', worktreePath, filePath),
    bulkUnstage: async ({ worktreePath, filePaths }) =>
      mutateGitPaths('git.bulkUnstage', worktreePath, filePaths),
    discard: async ({ worktreePath, filePath }) =>
      mutateGitPath('git.discard', worktreePath, filePath),
    bulkDiscard: async ({ worktreePath, filePaths }) => {
      for (const filePath of filePaths) {
        await mutateGitPath('git.discard', worktreePath, filePath)
      }
    },
    remoteFileUrl: async ({ worktreePath, relativePath, line }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.remoteFileUrl', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        relativePath,
        line
      })
    },
    remoteCommitUrl: async ({ worktreePath, sha }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.remoteCommitUrl', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        sha
      })
    }
  }
}

export async function mutateGitPath(
  method: string,
  worktreePath: string,
  filePath: string
): Promise<void> {
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult(method, {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath
  })
}

export async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[]
): Promise<void> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: toRuntimeWorktreeSelector(worktree.id), filePaths })
}
