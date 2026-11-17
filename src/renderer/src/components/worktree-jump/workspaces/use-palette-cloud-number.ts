import { useCallback } from 'react'
import {
  cloudNumberForWorktree,
  useCloudWorkspaceIdentities
} from '@/components/cloud-workspaces/cloud-workspace-identity'

type CloudNumberReader = (worktree: { id: string; hostId?: string | null }) => number | null

/** Cloud workspaces are searchable by number (W-123); the reader changes only when numbers do. */
export function usePaletteCloudNumberForWorktree(): CloudNumberReader {
  const cloudIdentities = useCloudWorkspaceIdentities()
  return useCallback<CloudNumberReader>(
    (worktree) => cloudNumberForWorktree(worktree, cloudIdentities),
    [cloudIdentities]
  )
}
