import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudSshMenuState, type CloudSshWorktree } from '../cloud-ssh/use-cloud-ssh-status'

/** A9: the control plane runs each agent's sign-out on an awake sandbox before deleting it. */
export function DeleteCloudSandboxAgentsNote({
  worktree
}: {
  worktree: CloudSshWorktree
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useCloudSshMenuState(worktree)
  // Asleep sandboxes are never woken for it; their disk goes with the delete.
  if (state.kind !== 'ready' || state.status.asleep) {
    return null
  }
  return (
    <p className="text-xs text-muted-foreground">
      {t(
        'auto.components.sidebar.DeleteWorktreeDialog.cloudSignsAgentsOut',
        'Signs agents out on the sandbox first.'
      )}
    </p>
  )
}
