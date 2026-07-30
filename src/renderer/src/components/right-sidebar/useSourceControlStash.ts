import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/types'
import type { GitStashEntry } from '../../../../shared/git-stash-types'
import {
  applyRuntimeGitStash,
  clearRuntimeGitStashes,
  dropRuntimeGitStash,
  listRuntimeGitStashes,
  popRuntimeGitStash,
  pushRuntimeGitStash
} from '@/runtime/runtime-git-client'
import type { DropdownActionKind } from './source-control-dropdown-items'
import {
  dropAllStashesConfirmation,
  dropStashConfirmation,
  isStashEntryMovedError,
  isStashMessagePromptAction,
  isStashPickerAction,
  stashEntryMovedMessage,
  stashPushErrorMessage,
  stashPushOutcomeMessage,
  stashRestoreErrorMessage,
  type StashMessagePromptMode,
  type StashPickerMode
} from './source-control-stash-actions'

type StashContext = {
  settings: GlobalSettings | null
  worktreeId: string | null
  worktreePath: string | null
  connectionId?: string
  /** Folder workspaces have no git; every stash call must no-op for them. */
  isGitWorkspace: boolean
}

type ConfirmAction = (options: {
  title: string
  description: string
  confirmLabel: string
  confirmVariant?: 'default' | 'destructive'
}) => Promise<boolean>

export type SourceControlStash = {
  /** undefined until read — the menu renders "Checking stashes…" meanwhile. */
  stashCount: number | undefined
  pickerMode: StashPickerMode | null
  closePicker: () => void
  /** Set while the user is naming a stash; null when no prompt is open. */
  messagePromptMode: StashMessagePromptMode | null
  submitStashMessage: (message: string) => Promise<void>
  cancelStashMessage: () => void
  refreshStashCount: () => Promise<void>
  listEntries: () => Promise<GitStashEntry[]>
  runStashAction: (kind: DropdownActionKind) => Promise<void>
  selectPickedStash: (entry: GitStashEntry) => Promise<void>
}

/**
 * Owns stash state for the Source Control panel.
 *
 * The count is fetched on demand (menu open, panel visible, after a mutation)
 * rather than joining `useGitStatusPolling`: unlike upstream status, which rides
 * along in porcelain v2 for free, a stash count is a separate `git log` on
 * refs/stash, and it only matters while the menu is open.
 */
export function useSourceControlStash(
  context: StashContext,
  confirmAction: ConfirmAction,
  onAfterMutation: () => Promise<void>
): SourceControlStash {
  const [stashCount, setStashCount] = useState<number | undefined>(undefined)
  const [pickerMode, setPickerMode] = useState<StashPickerMode | null>(null)
  const [messagePromptMode, setMessagePromptMode] = useState<StashMessagePromptMode | null>(null)
  const { settings, worktreeId, worktreePath, connectionId, isGitWorkspace } = context

  // Why: the count belongs to one worktree; clear it on switch so the next menu
  // shows "Checking stashes…" instead of the previous worktree's number.
  useEffect(() => {
    setStashCount(undefined)
    setPickerMode(null)
    setMessagePromptMode(null)
  }, [worktreeId])

  // Why: read the live worktree at response time. A refresh closure captures the
  // worktree it was created for, so comparing against the closure would always
  // match; without this, a slow read for worktree A lands on worktree B and
  // re-enables restore rows for stashes that are not there.
  const activeWorktreeIdRef = useRef(worktreeId)
  activeWorktreeIdRef.current = worktreeId

  const runtimeContext = useCallback(() => {
    if (!settings || !worktreeId || !worktreePath || !isGitWorkspace) {
      return null
    }
    return { settings, worktreeId, worktreePath, connectionId }
  }, [settings, worktreeId, worktreePath, connectionId, isGitWorkspace])

  const listEntries = useCallback(async (): Promise<GitStashEntry[]> => {
    const ctx = runtimeContext()
    if (!ctx) {
      return []
    }
    return listRuntimeGitStashes(ctx)
  }, [runtimeContext])

  const refreshStashCount = useCallback(async (): Promise<void> => {
    const ctx = runtimeContext()
    if (!ctx) {
      return
    }
    try {
      const entries = await listRuntimeGitStashes(ctx)
      if (activeWorktreeIdRef.current !== ctx.worktreeId) {
        return
      }
      setStashCount(entries.length)
    } catch (error) {
      // Why: a failed count must not block the menu — leave it unknown so the
      // rows stay disabled with the loading reason rather than claiming zero.
      console.warn('[SourceControl] stash count refresh failed', error)
    }
  }, [runtimeContext])

  const finishMutation = useCallback(async (): Promise<void> => {
    await onAfterMutation()
    await refreshStashCount()
  }, [onAfterMutation, refreshStashCount])

  const restore = useCallback(
    async (mode: 'apply' | 'pop', entry: GitStashEntry | null): Promise<void> => {
      const ctx = runtimeContext()
      if (!ctx) {
        return
      }
      const target = entry ? { ref: entry.ref, expectedCommitOid: entry.commitOid } : null
      const result =
        mode === 'apply'
          ? await applyRuntimeGitStash(ctx, target)
          : await popRuntimeGitStash(ctx, target)
      if (!result.success) {
        const message = stashRestoreErrorMessage(result, entry?.ref ?? null)
        // Why: a conflict is an outcome the user must act on, not a plain error.
        if (result.conflicted) {
          toast.warning(message)
        } else {
          toast.error(message)
        }
      }
      await finishMutation()
    },
    [runtimeContext, finishMutation]
  )

  const submitStashMessage = useCallback(
    async (message: string): Promise<void> => {
      const mode = messagePromptMode
      const ctx = runtimeContext()
      setMessagePromptMode(null)
      if (!mode || !ctx) {
        return
      }
      const trimmed = message.trim()
      try {
        const result = await pushRuntimeGitStash(ctx, {
          includeUntracked: mode === 'stash_include_untracked',
          // Why: an empty name is a valid choice, not an omission — drop the
          // field so git writes its own "WIP on <branch>" subject.
          ...(trimmed.length > 0 ? { message: trimmed } : {})
        })
        if (!result.success) {
          toast.error(stashPushErrorMessage(result.error))
        } else {
          const notice = stashPushOutcomeMessage(result.stashed)
          if (notice) {
            toast.info(notice)
          }
        }
      } catch (error) {
        reportStashError(error)
      }
      await finishMutation()
    },
    [messagePromptMode, runtimeContext, finishMutation]
  )

  const runStashAction = useCallback(
    async (kind: DropdownActionKind): Promise<void> => {
      const ctx = runtimeContext()
      if (!ctx) {
        return
      }
      try {
        if (kind === 'stash_pop_latest') {
          await restore('pop', null)
          return
        }
        if (kind === 'stash_apply_latest') {
          await restore('apply', null)
          return
        }
        if (kind === 'stash_drop_all') {
          const count = stashCount ?? 0
          const confirmation = dropAllStashesConfirmation(count)
          if (!(await confirmAction({ ...confirmation, confirmVariant: 'destructive' }))) {
            return
          }
          await clearRuntimeGitStashes(ctx)
          await finishMutation()
        }
      } catch (error) {
        reportStashError(error)
        await finishMutation()
      }
    },
    [runtimeContext, restore, finishMutation, confirmAction, stashCount]
  )

  const selectPickedStash = useCallback(
    async (entry: GitStashEntry): Promise<void> => {
      const mode = pickerMode
      const ctx = runtimeContext()
      setPickerMode(null)
      if (!mode || !ctx) {
        return
      }
      try {
        if (mode === 'stash_drop_pick') {
          const confirmation = dropStashConfirmation(entry)
          if (!(await confirmAction({ ...confirmation, confirmVariant: 'destructive' }))) {
            return
          }
          await dropRuntimeGitStash(ctx, { ref: entry.ref, expectedCommitOid: entry.commitOid })
          await finishMutation()
          return
        }
        await restore(mode === 'stash_apply_pick' ? 'apply' : 'pop', entry)
      } catch (error) {
        reportStashError(error)
        await finishMutation()
      }
    },
    [pickerMode, runtimeContext, confirmAction, restore, finishMutation]
  )

  const closePicker = useCallback(() => setPickerMode(null), [])
  // Why: cancelling is distinct from confirming an empty name — it must not stash.
  const cancelStashMessage = useCallback(() => setMessagePromptMode(null), [])

  const dispatchStashAction = useCallback(
    async (kind: DropdownActionKind) => {
      // Why: naming is prompted for rather than implicit, so both stash rows and
      // the three picker rows open a dialog instead of running git directly.
      if (isStashMessagePromptAction(kind)) {
        setMessagePromptMode(kind)
        return
      }
      if (isStashPickerAction(kind)) {
        setPickerMode(kind)
        return
      }
      await runStashAction(kind)
    },
    [runStashAction]
  )

  // Why: memoize the facade so callers can depend on it without their own
  // useCallbacks silently degrading to a no-op on every parent render.
  return useMemo(
    () => ({
      stashCount,
      pickerMode,
      closePicker,
      messagePromptMode,
      submitStashMessage,
      cancelStashMessage,
      refreshStashCount,
      listEntries,
      runStashAction: dispatchStashAction,
      selectPickedStash
    }),
    [
      stashCount,
      pickerMode,
      closePicker,
      messagePromptMode,
      submitStashMessage,
      cancelStashMessage,
      refreshStashCount,
      listEntries,
      dispatchStashAction,
      selectPickedStash
    ]
  )
}

function reportStashError(error: unknown): void {
  if (isStashEntryMovedError(error)) {
    toast.error(stashEntryMovedMessage())
    return
  }
  toast.error(
    error instanceof Error
      ? error.message
      : translate(
          'auto.components.right.sidebar.useSourceControlStash.failed',
          'Stash operation failed.'
        )
  )
}
