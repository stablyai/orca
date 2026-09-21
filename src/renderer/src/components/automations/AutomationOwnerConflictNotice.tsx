import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  recoveryActionLabel,
  type AutomationHostRecoveryAction
} from './automation-host-status-descriptors'
import type { AutomationOwnerConflict } from './automation-owner-action-runner'
import type { AutomationActionBlock } from './automation-captured-owner'

/**
 * An owner conflict shown where the user was working, not as a toast: the
 * request performed nothing, so the message has to survive long enough to be
 * read and acted on. It offers a recovery action only when one exists — a host
 * that was deregistered gets a plain explanation rather than a button that
 * cannot help.
 */

type AutomationOwnerNotice = {
  message: string
  recovery: AutomationHostRecoveryAction | null
}

export function ownerConflictNotice(conflict: AutomationOwnerConflict): AutomationOwnerNotice {
  return { message: conflict.message, recovery: conflict.recovery }
}

export function actionBlockNotice(block: AutomationActionBlock): AutomationOwnerNotice {
  return { message: block.message, recovery: block.recovery }
}

type AutomationOwnerConflictNoticeProps = {
  notice: AutomationOwnerNotice | null
  onRecover?: (action: AutomationHostRecoveryAction) => void
  onDismiss?: () => void
  className?: string
}

export function AutomationOwnerConflictNotice({
  notice,
  onRecover,
  onDismiss,
  className
}: AutomationOwnerConflictNoticeProps): React.JSX.Element | null {
  if (!notice) {
    return null
  }
  const recovery = notice.recovery
  return (
    <div
      role="alert"
      data-testid="automation-owner-conflict"
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-foreground dark:border-amber-500/35 dark:bg-amber-500/15',
        className
      )}
    >
      <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="min-w-0 flex-1 leading-normal font-medium">{notice.message}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        {recovery && onRecover ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="border-amber-500/40 bg-background font-medium text-foreground shadow-xs hover:bg-muted"
            onClick={() => onRecover(recovery)}
          >
            {recoveryActionLabel(recovery)}
          </Button>
        ) : null}
        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:bg-amber-500/20 hover:text-foreground"
            onClick={onDismiss}
          >
            {translate('auto.components.automations.ownerConflict.dismiss', 'Dismiss')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
