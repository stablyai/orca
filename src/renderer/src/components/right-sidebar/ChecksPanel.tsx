import React from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { ChecksPanelInner } from './ChecksPanelInner'

/**
 * Right-sidebar Checks tab. Thin wrapper that binds {@link ChecksPanelInner} to
 * the active worktree: it reads the active worktree/repo/linked-review identity
 * from the store and passes them down as explicit props. The inner component is
 * agnostic about whether its target is the active worktree, so the same UI can
 * be driven from a shipped-PR identity elsewhere (PR2: Orcastrator Mission Control).
 */
export default function ChecksPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const gitIdentityDisplay = activeWorktree ? getWorktreeGitIdentityDisplay(activeWorktree) : null

  return (
    <ChecksPanelInner
      worktree={activeWorktree}
      worktreeId={activeWorktreeId}
      repo={repo}
      gitIdentityDisplay={gitIdentityDisplay}
      linkedPR={activeWorktree?.linkedPR ?? null}
      linkedGitLabMR={activeWorktree?.linkedGitLabMR ?? null}
      linkedBitbucketPR={activeWorktree?.linkedBitbucketPR ?? null}
      linkedAzureDevOpsPR={activeWorktree?.linkedAzureDevOpsPR ?? null}
      linkedGiteaPR={activeWorktree?.linkedGiteaPR ?? null}
    />
  )
}
