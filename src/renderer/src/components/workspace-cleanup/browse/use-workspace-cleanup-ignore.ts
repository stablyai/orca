import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Ignore keeps a row out of bulk delete until it changes; the row's Stop ignoring undoes it. */
export function useWorkspaceCleanupIgnore(setSelectedIds: Dispatch<SetStateAction<Set<string>>>): {
  /** Resolve true once the change is recorded, so callers can react after it is visible. */
  ignoreCandidate: (candidate: WorkspaceCleanupCandidate) => Promise<boolean>
  restoreCandidate: (candidate: WorkspaceCleanupCandidate) => Promise<boolean>
} {
  const dismissCandidates = useAppStore((s) => s.dismissWorkspaceCleanupCandidates)
  const restoreCandidates = useAppStore((s) => s.restoreWorkspaceCleanupCandidates)
  const mountedRef = useMountedRef()

  const restoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      return restoreCandidates([candidate])
        .then(() => true)
        .catch((err: unknown) => {
          if (!mountedRef.current) {
            return false
          }
          toast.error(
            translate(
              'components.workspace.cleanup.browse.restoreFailed',
              'Could not stop ignoring {{value0}}',
              { value0: candidate.displayName }
            ),
            { description: describeError(err) }
          )
          return false
        })
    },
    [mountedRef, restoreCandidates]
  )

  const ignoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      return dismissCandidates([candidate])
        .then(() => {
          if (mountedRef.current) {
            setSelectedIds((current) => {
              const next = new Set(current)
              next.delete(getWorkspaceCleanupCandidateIdentity(candidate))
              return next
            })
          }
          return true
        })
        .catch((err: unknown) => {
          if (mountedRef.current) {
            toast.error(
              translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7f451a3e2c',
                'Could not ignore cleanup suggestion'
              ),
              { description: describeError(err) }
            )
          }
          return false
        })
    },
    [dismissCandidates, mountedRef, setSelectedIds]
  )

  return { ignoreCandidate, restoreCandidate }
}
