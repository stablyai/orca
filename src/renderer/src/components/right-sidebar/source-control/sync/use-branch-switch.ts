import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import {
  checkoutRuntimeGitBranch,
  createRuntimeGitBranch,
  listRuntimeGitLocalBranches
} from '@/runtime/runtime-git-client'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import type { GitLocalBranchListing } from '../../../../../../shared/git-local-branches'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { buildBranchPickerRows, type BranchPickerRow } from '../panel/branch-picker-rows'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'

/** An older host answers `git.createBranch` with method_not_found rather than creating. */
function isUnsupportedMethodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('method_not_found') || message.includes('Unknown method')
}

/**
 * Drives the Source Control branch picker: loads local branches on open, then
 * switches to or creates one. Git refuses a checkout that would clobber
 * uncommitted work, and that refusal is surfaced verbatim rather than forced —
 * the user decides whether to commit first.
 */
export function useSourceControlBranchSwitch({
  activeRepoSettings,
  activeWorktreeId,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  worktreePath
}: {
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  worktreePath: string | null
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<GitLocalBranchListing | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [worktreeLabelByPath, setWorktreeLabelByPath] = useState<ReadonlyMap<string, string>>(
    new Map()
  )
  const [isBusy, setIsBusy] = useState(false)

  const canSwitch = activeWorktreeId !== null && worktreePath !== null

  const runtimeContext = useCallback(() => {
    if (!activeWorktreeId || !worktreePath) {
      return null
    }
    return {
      // Why: route by the repo OWNER host, matching every other source-control git call.
      settings: activeRepoSettings,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: getConnectionId(activeWorktreeId) ?? undefined
    }
  }, [activeRepoSettings, activeWorktreeId, worktreePath])

  const loadBranches = useCallback(async (): Promise<void> => {
    const context = runtimeContext()
    if (!context) {
      return
    }
    setIsLoading(true)
    // Why: snapshot sibling worktrees alongside the listing so occupancy reads as
    // a workspace name; reading the store during render would refresh on nothing.
    const repoId = getRepoIdFromWorktreeId(context.worktreeId)
    const labels = new Map<string, string>()
    for (const worktree of useAppStore.getState().worktreesByRepo[repoId] ?? []) {
      labels.set(normalizeRuntimePathForComparison(worktree.path), worktree.displayName)
    }
    setWorktreeLabelByPath(labels)
    try {
      setListing(await listRuntimeGitLocalBranches(context))
    } catch {
      // Why: an empty listing still lets the user type a name and create it.
      setListing({ current: null, branches: [] })
    } finally {
      setIsLoading(false)
    }
  }, [runtimeContext])

  const openPicker = useCallback(
    (open: boolean): void => {
      setIsOpen(open)
      if (!open) {
        return
      }
      setQuery('')
      setListing(null)
      void loadBranches()
    },
    [loadBranches]
  )

  const rows: BranchPickerRow[] = useMemo(
    () => buildBranchPickerRows({ listing, query, worktreePath, worktreeLabelByPath }),
    [listing, query, worktreePath, worktreeLabelByPath]
  )

  const run = useCallback(
    async (branch: string, mode: 'switch' | 'create'): Promise<void> => {
      const context = runtimeContext()
      if (!context || isBusy) {
        return
      }
      setIsBusy(true)
      try {
        if (mode === 'create') {
          await createRuntimeGitBranch(context, branch)
          toast.success(
            translate('auto.components.right.sidebar.SourceControl.4bc4d3b0dc', 'Created {{value0}}', {
              value0: branch
            })
          )
        } else {
          await checkoutRuntimeGitBranch(context, branch)
          toast.success(
            translate(
              'auto.components.right.sidebar.SourceControl.c1e2e60a6b',
              'Switched to {{value0}}',
              { value0: branch }
            )
          )
        }
        setIsOpen(false)
      } catch (error) {
        const description =
          mode === 'create' && isUnsupportedMethodError(error)
            ? translate(
                'auto.components.right.sidebar.SourceControl.ac1edbe604',
                'This host does not support creating branches. Update Orca on the remote host.'
              )
            : error instanceof Error
              ? error.message
              : String(error)
        toast.error(
          mode === 'create'
            ? translate(
                'auto.components.right.sidebar.SourceControl.7da2448a29',
                'Create branch failed'
              )
            : translate(
                'auto.components.right.sidebar.SourceControl.f4b9a48c43',
                'Switch branch failed'
              ),
          { description }
        )
      } finally {
        setIsBusy(false)
        refreshSourceControlAfterRemoteAction({
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
      }
    },
    [
      isBusy,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      runtimeContext
    ]
  )

  return {
    canSwitch,
    isBusy,
    isLoading,
    isOpen,
    listing,
    onOpenChange: openPicker,
    query,
    rows,
    setQuery,
    switchToBranch: useCallback((branch: string) => void run(branch, 'switch'), [run]),
    createBranch: useCallback((branch: string) => void run(branch, 'create'), [run])
  }
}

export type SourceControlBranchSwitch = ReturnType<typeof useSourceControlBranchSwitch>
