import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import {
  buildFolderStatusMap,
  buildStatusMap
} from '../../../../lib/source-control/paths/git-path-decoration'

// Why: a stable reference keeps the selector from re-rendering the pane when the active worktree has no status.
const NO_GIT_STATUS_ENTRIES: GitStatusEntry[] = []

/** Download eligibility, platform, and git decorations the files pane renders. */
export function useFileExplorerPaneFacts({
  activeWorktreeId,
  connectionId,
  ownerRuntimeEnvironmentId,
  worktreePath
}: {
  activeWorktreeId: string | null
  connectionId?: string | null
  ownerRuntimeEnvironmentId: string | null
  worktreePath: string | null
}) {
  const entries = useAppStore((state) =>
    activeWorktreeId
      ? (state.gitStatusByWorktree[activeWorktreeId] ?? NO_GIT_STATUS_ENTRIES)
      : NO_GIT_STATUS_ENTRIES
  )
  const supportsFolderDownload = useAppStore((state) =>
    connectionId
      ? state.sshConnectionStates.get(connectionId)?.supportsFolderDownload === true
      : false
  )
  const runtimeDownloadContext = useMemo(
    () =>
      ownerRuntimeEnvironmentId && activeWorktreeId && worktreePath
        ? {
            target: runtimeTargetForOwnerEnvironment(ownerRuntimeEnvironmentId),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: connectionId ?? undefined
          }
        : null,
    [connectionId, ownerRuntimeEnvironmentId, activeWorktreeId, worktreePath]
  )
  const isWindows = useMemo(() => navigator.userAgent.includes('Windows'), [])
  const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries])
  const folderStatusByRelativePath = useMemo(() => buildFolderStatusMap(entries), [entries])
  return {
    supportsFolderDownload,
    runtimeDownloadContext,
    isWindows,
    statusByRelativePath,
    folderStatusByRelativePath
  }
}
