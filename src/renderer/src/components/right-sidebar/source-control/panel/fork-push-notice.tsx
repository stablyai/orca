import React from 'react'
import { GitFork } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import { describeForkPushTarget } from './fork-push-target-label'

export function SourceControlForkPushNotice({
  pushTarget
}: {
  pushTarget: GitPushTarget | null
}): React.JSX.Element | null {
  if (!pushTarget || pushTarget.remoteName === 'origin') {
    return null
  }
  return (
    <div
      className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
      title={translate(
        'auto.components.right.sidebar.SourceControl.c05fe04839',
        'Pushes to the fork at {{value0}} (not origin)',
        { value0: pushTarget.remoteName }
      )}
    >
      <GitFork className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {translate('auto.components.right.sidebar.SourceControl.78ce2d37ac', 'Pushes to fork')}{' '}
        {describeForkPushTarget(pushTarget)}
      </span>
    </div>
  )
}
