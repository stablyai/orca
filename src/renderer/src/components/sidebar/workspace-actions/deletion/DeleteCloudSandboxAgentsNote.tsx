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
  // Only a running sandbox is signed out; asleep or archived ones are never woken for it.
  if (state.kind !== 'ready' || state.status.running !== true) {
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
