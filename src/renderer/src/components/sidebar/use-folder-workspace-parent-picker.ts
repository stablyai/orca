import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { FolderParentMutationError } from '@/store/slices/worktrees/metadata/worktree-folder-parent-actions'
import type { FolderParentPickerData } from '@/store/slices/worktrees/metadata/worktree-folder-parent-actions'
import { useWorktreeParentMutationPending } from '@/store/slices/worktrees/metadata/worktree-parent-mutation-guard'
import {
  getEligibleFolderWorkspaceParents,
  type FolderParentContext
} from './folder-workspace-parent-candidates'

export function useFolderWorkspaceParentPicker(
  context: FolderParentContext | null | undefined,
  open: boolean,
  close: () => void
) {
  const load = useAppStore((state) => state.loadFolderParentCatalog)
  const attach = useAppStore((state) => state.attachWorktreeToFolderWorkspace)
  const [data, setData] = useState<FolderParentPickerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const pending = useWorktreeParentMutationPending(context?.mutationKey ?? null)
  useEffect(() => {
    if (!open || context === undefined) {
      return
    }
    if (!context) {
      setError(
        translate(
          'auto.components.sidebar.FolderParentPicker.ownerUnavailable',
          'Workspace ownership is unavailable. Refresh workspace metadata and retry.'
        )
      )
      return
    }
    let disposed = false
    setLoading(true)
    setData(null)
    setError(null)
    void load(context)
      .then((catalog) => {
        if (!disposed) {
          setData(catalog)
        }
      })
      .catch(() => {
        if (!disposed) {
          setError(
            translate(
              'auto.components.sidebar.FolderParentPicker.loadFailed',
              'Could not load folder workspaces for this execution host.'
            )
          )
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [context, load, open, revision])
  const entries = useMemo(
    () => (context && data ? getEligibleFolderWorkspaceParents(context, data, data.lineage) : []),
    [context, data]
  )
  const candidates = useMemo(
    () => entries.map((entry) => folderWorkspaceToWorktree(entry.folder)),
    [entries]
  )
  const byId = useMemo(
    () => new Map(entries.map((entry) => [`folder:${entry.folder.id}`, entry])),
    [entries]
  )
  const select = async (id: string): Promise<void> => {
    const scope = parseWorkspaceKey(id)
    const entry = byId.get(id)
    if (!context || scope?.type !== 'folder' || !entry || pending) {
      return
    }
    if (entry.isCurrent) {
      close()
      return
    }
    setError(null)
    try {
      await attach(context, scope.folderWorkspaceId)
      close()
    } catch (failure) {
      if (failure instanceof FolderParentMutationError && failure.outcome === 'unknown') {
        setError(
          translate(
            'auto.components.sidebar.FolderParentPicker.unknownOutcome',
            'Parent update outcome is unknown. Refresh to verify before trying again.'
          )
        )
      } else if (
        failure instanceof FolderParentMutationError &&
        failure.outcome === 'acknowledged'
      ) {
        setError(
          translate(
            'auto.components.sidebar.FolderParentPicker.refreshUnverified',
            'Parent update was acknowledged, but the view could not be refreshed. Refresh to verify.'
          )
        )
      } else {
        setError(
          translate(
            'auto.components.sidebar.FolderParentPicker.attachFailed',
            'Could not attach worktree to folder workspace.'
          )
        )
      }
    }
  }
  return {
    candidates,
    byId,
    error,
    loading,
    pending,
    select,
    reload: () => setRevision((value) => value + 1)
  }
}
