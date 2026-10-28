import { useRef } from 'react'
import { toast } from 'sonner'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { useMountedRef } from '@/hooks/useMountedRef'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { resolveSshHostRemoval } from '../sidebar/ssh-host-remove-resolution'
import { isManagedServerSshHost } from './SshManagedHostRemoveDialog'
import type { SshBulkRemoveRequest, SshBulkRemoveResult } from './SshTargetDestructiveActions'
import { planSshBulkRemove, type SshBulkRemovePlan } from './ssh-target-list-model'
import { summarizeSshBulkRemove } from './ssh-bulk-remove-summary'

type PlainRemoveTarget = { id: string; label: string }

export function useSshBulkRemove(args: {
  targets: readonly SshTarget[]
  selected: ReadonlySet<string>
  clearSelection: () => void
  reload: () => Promise<void>
  requestSingleRemove: (
    target: SshTarget,
    requestPlainRemove: (target: PlainRemoveTarget) => void
  ) => void
}): {
  requestRemoveSelected: (
    requestBulkRemove: (request: SshBulkRemoveRequest) => void,
    requestPlainRemove: (target: PlainRemoveTarget) => void
  ) => void
  finishBulkRemove: (result: SshBulkRemoveResult) => Promise<void>
} {
  const mountedRef = useMountedRef()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // Retain click-time skip decisions until the confirmed removal finishes.
  const skippedRef = useRef<SshBulkRemovePlan['skipped']>([])

  const finishBulkRemove = async (result: SshBulkRemoveResult): Promise<void> => {
    const summary = summarizeSshBulkRemove({
      removedCount: result.removed.length,
      skipped: skippedRef.current,
      failed: result.failed.map(({ target, error }) => ({
        label: target.label,
        message: extractIpcErrorMessage(
          error,
          translate('auto.components.settings.SshPane.c2a69510e3', 'Failed to remove target')
        )
      }))
    })
    skippedRef.current = []
    if (result.removed.length > 0) {
      recordFeatureInteraction('ssh')
      await args.reload()
    }
    if (!mountedRef.current) {
      return
    }
    args.clearSelection()
    const notify =
      summary.tone === 'success' ? toast.success : summary.tone === 'error' ? toast.error : toast
    notify(summary.title, summary.description ? { description: summary.description } : undefined)
  }

  const requestRemoveSelected = (
    requestBulkRemove: (request: SshBulkRemoveRequest) => void,
    requestPlainRemove: (target: PlainRemoveTarget) => void
  ): void => {
    const chosen = args.targets.filter((target) => args.selected.has(target.id))
    // Single removals retain their managed-server/workspace dialogs instead of being skipped.
    if (chosen.length === 1) {
      args.requestSingleRemove(chosen[0], requestPlainRemove)
      return
    }
    const state = useAppStore.getState()
    const worktrees = getAllWorktreesFromState(state)
    const plan = planSshBulkRemove(chosen, (target) => {
      if (isManagedServerSshHost(target)) {
        return 'managed-server'
      }
      const resolution = resolveSshHostRemoval({
        targetId: target.id,
        repos: state.repos,
        worktrees,
        sshConnectionStates: state.sshConnectionStates
      })
      return resolution.workspaceCount > 0 ? 'workspaces' : null
    })
    skippedRef.current = plan.skipped
    if (plan.removable.length === 0) {
      void finishBulkRemove({ removed: [], failed: [] })
      return
    }
    requestBulkRemove({
      targets: plan.removable.map((target) => ({ id: target.id, label: target.label })),
      connectedCount: plan.removable.filter(
        (target) => state.sshConnectionStates.get(target.id)?.status === 'connected'
      ).length
    })
  }

  return { requestRemoveSelected, finishBulkRemove }
}
