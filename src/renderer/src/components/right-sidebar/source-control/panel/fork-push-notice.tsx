import React from 'react'
import { GitFork } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import { describeForkPushTarget } from './fork-push-target-label'

export function SourceControlForkPushNotice({
  pushTarget
}: {
  pushTarget: GitPushTarget | null
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!pushTarget || pushTarget.remoteName === 'origin') {
    return null
  }
  return (
    <div
      className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
      title={t(
        'auto.components.right.sidebar.SourceControl.c05fe04839',
        'Pushes to the fork at {{value0}} (not origin)',
        { value0: pushTarget.remoteName }
      )}
    >
      <GitFork className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {t(
          'auto.components.right.sidebar.SourceControl.pushesToForkTarget',
          'Pushes to fork {{target}}',
          {
            target: describeForkPushTarget(pushTarget)
          }
        )}
      </span>
    </div>
  )
}
