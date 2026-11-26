import { useCallback, useEffect, useRef } from 'react'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import {
  commitCompareKey,
  commitDiffErrorMessage,
  runLatestCommitDiffOpen,
  trackCommitCompare,
  type CommitCompareReads
} from './git-history-commit-compare'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRuntimeGitCommitCompare } from '@/runtime/source-control/git/runtime-git-diff-client'
import { getRuntimeGitRemoteCommitUrl } from '@/runtime/source-control/git/runtime-git-working-tree-client'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'

import { translate } from '@/i18n/i18n'
import { explainCommitWithDefaultAgent } from './explain-commit-with-agent'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'
import type {
  GitBranchChangeEntry,
  GitCommitCompareResult
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import {
  shouldOpenSourceControlRowAsPreview,
  type SourceControlRowOpenEvent
} from '../listing/split-open'
import type { GitHistoryCommitAction } from './git-history-commit-context-menu'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'

const EMPTY_BRANCH_CHANGE_ENTRIES: GitBranchChangeEntry[] = []

type CommitCompareGeneration = CommitCompareReads & { key: string }

type GitHistoryCommitActions = {
  loadCommitFiles: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  openHistoryCommitDiff: (item: GitHistoryItem) => Promise<void>
  openCommitFile: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  handleCommitAction: (action: GitHistoryCommitAction, item: GitHistoryItem) => void
}

export function useGitHistoryCommitActions({
  activeWorktreeId,
  worktreePath,
  activeRepoTarget,
  ownerConnectionId,
  resolveSplitTargetGroupId,
  isSurfaceOpen,
  placementWorkspaceId: placementOverride
}: {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  activeRepoTarget: RuntimeClientTarget | null
  ownerConnectionId?: string | null
  resolveSplitTargetGroupId: (event?: SourceControlRowOpenEvent) => string | undefined
  /** False once the view that asked for an Open diff has closed; a hidden tab still counts as open. */
  isSurfaceOpen?: () => boolean
  /** The workspace showing the view when no source control scope provides it, e.g. a Git Graph tab. */
  placementWorkspaceId?: string
}): GitHistoryCommitActions {
  const scope = useSourceControlScope()
  const executionHostId = scope?.executionHostId
  const placementWorkspaceId = placementOverride ?? scope?.placementWorkspaceId
  const runtimeEnvironmentId = scope?.runtimeOwnerEnvironmentId

  // One generation per worktree + repo-owner authority; its cache shares compare results across loads and opens.
  const generationKey = JSON.stringify([
    activeWorktreeId ?? null,
    activeRepoTarget?.kind ?? null,
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null,
    activeWorktreeId
      ? (sourceControlConnectionId(scope, activeWorktreeId, ownerConnectionId) ?? null)
      : null
  ])
  const generationRef = useRef<CommitCompareGeneration>({
    key: generationKey,
    cache: new Map(),
    pending: new Map()
  })
  useEffect(() => {
    if (generationRef.current.key !== generationKey) {
      generationRef.current = { key: generationKey, cache: new Map(), pending: new Map() }
    }
  }, [generationKey])

  const loadCommitCompare = useCallback(
    async (item: GitHistoryItem): Promise<GitCommitCompareResult | null> => {
      if (!activeWorktreeId || !worktreePath) {
        return null
      }
      const generation = generationRef.current
      const compareKey = commitCompareKey(item)
      const cached = generation.cache.get(compareKey)
      if (cached) {
        return cached
      }
      const connectionId = sourceControlConnectionId(scope, activeWorktreeId, ownerConnectionId)
      return trackCommitCompare(generation, compareKey, () =>
        getRuntimeGitCommitCompare(
          {
            // Compare on the repo owner, which may differ from the focused host.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          item.id
        )
      )
    },
    [activeRepoTarget, activeWorktreeId, scope, worktreePath, ownerConnectionId]
  )

  const loadCommitFiles = useCallback(
    async (item: GitHistoryItem): Promise<GitBranchChangeEntry[]> =>
      (await loadCommitCompare(item))?.entries ?? EMPTY_BRANCH_CHANGE_ENTRIES,
    [loadCommitCompare]
  )

  const openHistoryCommitDiff = useCallback(
    async (item: GitHistoryItem): Promise<void> => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const generation = generationRef.current
      // A worktree or host change, a newer open of this commit, or closing the view drops the open.
      // Switching away from a still-open tab does not, and neither does a scope change in the list.
      await runLatestCommitDiffOpen(
        JSON.stringify([generation.key, item.id]),
        () => loadCommitCompare(item),
        () => generationRef.current === generation && (isSurfaceOpen?.() ?? true),
        (compare) => {
          useAppStore
            .getState()
            .openCommitAllDiffs(
              activeWorktreeId,
              worktreePath,
              compare.summary,
              compare.entries,
              item.subject,
              item.message,
              { placementWorkspaceId, runtimeEnvironmentId, executionHostId }
            )
        },
        (error) => toast.error(commitDiffErrorMessage(error))
      )
    },
    [
      activeWorktreeId,
      isSurfaceOpen,
      loadCommitCompare,
      placementWorkspaceId,
      executionHostId,
      runtimeEnvironmentId,
      worktreePath
    ]
  )

  const openCommitFile = useCallback(
    (
      item: GitHistoryItem,
      entry: GitBranchChangeEntry,
      event?: SourceControlRowOpenEvent
    ): void => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const cached = generationRef.current.cache.get(commitCompareKey(item))
      if (!cached) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      useAppStore.getState().openCommitDiff(
        activeWorktreeId,
        worktreePath,
        entry,
        {
          commitOid: cached.summary.commitOid,
          parentOid: cached.summary.parentOid,
          compareRef: cached.summary.compareRef,
          baseRef: cached.summary.baseRef,
          subject: item.subject,
          message: item.message
        },
        detectLanguage(entry.path),
        {
          targetGroupId,
          placementWorkspaceId,
          executionHostId,
          runtimeEnvironmentId,
          preview: shouldOpenSourceControlRowAsPreview(event, targetGroupId)
        }
      )
    },
    [
      activeWorktreeId,
      placementWorkspaceId,
      executionHostId,
      resolveSplitTargetGroupId,
      runtimeEnvironmentId,
      worktreePath
    ]
  )

  const copyCommitText = useCallback(async (text: string, label: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(text)
      toast.success(
        translate('auto.components.right.sidebar.SourceControl.bf5082de46', '{{value0}} copied', {
          value0: label
        })
      )
    } catch {
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControl.c06193ef57',
          'Failed to copy {{value0}}',
          { value0: label.toLowerCase() }
        )
      )
    }
  }, [])

  const handleCommitAction = useCallback(
    (action: GitHistoryCommitAction, item: GitHistoryItem): void => {
      if (action === 'open-remote') {
        if (!activeWorktreeId || !worktreePath) {
          return
        }
        // Resolve the real origin in main; renderer origin identity is unreliable.
        void getRuntimeGitRemoteCommitUrl(
          {
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: sourceControlConnectionId(scope, activeWorktreeId, ownerConnectionId)
          },
          { sha: item.id }
        )
          .then((url) => {
            if (!url) {
              toast.error(
                translate(
                  'auto.components.right.sidebar.SourceControl.04a5d7239b',
                  'This repository has no supported web remote'
                )
              )
              return
            }
            return openWorkspaceBrowserTab({
              workspaceId: activeWorktreeId,
              url,
              intent: { kind: 'url' }
            })
          })
          .catch(() => {
            toast.error(
              translate(
                'auto.components.right.sidebar.SourceControl.15b6e834ac',
                'Failed to open commit in browser'
              )
            )
          })
        return
      }
      if (action === 'copy-hash') {
        void copyCommitText(
          item.id,
          translate('auto.components.right.sidebar.SourceControl.d172a4f068', 'Commit hash')
        )
        return
      }
      if (action === 'copy-message') {
        void copyCommitText(
          item.message || item.subject,
          translate('auto.components.right.sidebar.SourceControl.e283b50179', 'Commit message')
        )
        return
      }
      if (action !== 'explain') {
        return
      }
      if (!activeWorktreeId) {
        return
      }
      void explainCommitWithDefaultAgent(activeWorktreeId, item)
    },
    [activeRepoTarget, activeWorktreeId, copyCommitText, scope, worktreePath, ownerConnectionId]
  )

  return { loadCommitFiles, openHistoryCommitDiff, openCommitFile, handleCommitAction }
}
