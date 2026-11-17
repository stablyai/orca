import { toast } from 'sonner'
import { openFileInBrowserTab } from '@/lib/browser/documents/file-preview'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  sourceControlScopeRuntimeEnvironmentId,
  type SourceControlScopeRouting
} from '../panel/worktree-scope'

export type SourceControlRouting = {
  executionHostId?: ExecutionHostId
  placementWorkspaceId?: string
  runtimeEnvironmentId: string | null | undefined
}

/** The owner and pane every row action of a section uses. */
export function sourceControlRouting(
  scope: SourceControlScopeRouting | null
): SourceControlRouting {
  return {
    executionHostId: scope?.executionHostId,
    placementWorkspaceId: scope?.placementWorkspaceId,
    runtimeEnvironmentId: sourceControlScopeRuntimeEnvironmentId(scope)
  }
}

/** Row opens of a working-tree file on its repo's host, landing in the section's pane like View/Open do. */
export function sourceControlFileOpenActions({
  executionHostId,
  placementWorkspaceId,
  runtimeEnvironmentId
}: SourceControlRouting): {
  openInOrcaBrowser: (worktreeId: string, filePath: string) => void
  openMarkdownPreviewFile: (worktreeId: string, filePath: string, relativePath: string) => void
} {
  return {
    openInOrcaBrowser: (worktreeId, filePath) => {
      const plan = openFileInBrowserTab({
        filePath,
        worktreeId,
        refreshReusedPage: true,
        ...(placementWorkspaceId ? { placementWorkspaceId } : {}),
        ...(executionHostId ? { fileExecutionHostId: executionHostId } : {})
      })
      if (plan.status === 'unsupported') {
        toast.error(plan.message)
      }
    },
    openMarkdownPreviewFile: (worktreeId, filePath, relativePath) => {
      const state = useAppStore.getState()
      state.openMarkdownPreview(
        {
          filePath,
          relativePath,
          worktreeId,
          // Why never undefined: that would adopt the active runtime instead of this local repo.
          runtimeEnvironmentId:
            runtimeEnvironmentId !== undefined
              ? runtimeEnvironmentId
              : runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId),
          language: 'markdown'
        },
        placementWorkspaceId ? { placementWorkspaceId } : undefined
      )
    }
  }
}
