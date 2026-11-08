import React from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { getLocalizedConflictKindLabel } from './conflict-label'

function conflictBadgeAriaLabel(
  unresolved: boolean,
  kindLabel: string | null,
  t: Translate = translate
): string {
  if (unresolved) {
    return kindLabel
      ? t(
          'auto.components.right.sidebar.SourceControl.unresolvedConflictOfKind',
          'Unresolved conflict ({{kind}})',
          {
            kind: kindLabel
          }
        )
      : t('auto.components.right.sidebar.SourceControl.unresolvedConflict', 'Unresolved conflict')
  }
  return kindLabel
    ? t(
        'auto.components.right.sidebar.SourceControl.locallyResolvedConflictOfKind',
        'Conflict resolved locally ({{kind}})',
        {
          kind: kindLabel
        }
      )
    : t(
        'auto.components.right.sidebar.SourceControl.locallyResolvedConflict',
        'Conflict resolved locally'
      )
}

export function ConflictBadge({ entry }: { entry: GitStatusEntry }): React.JSX.Element {
  const t = useTranslate()
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const label = isUnresolvedConflict
    ? t('auto.components.right.sidebar.SourceControl.31f6d46278', 'Unresolved')
    : t('auto.components.right.sidebar.SourceControl.2c417432b7', 'Resolved locally')
  const conflictKindLabel = entry.conflictKind
    ? getLocalizedConflictKindLabel(entry.conflictKind, t)
    : null
  const Icon = isUnresolvedConflict ? TriangleAlert : CircleCheck
  const badge = (
    <span
      role="status"
      aria-label={conflictBadgeAriaLabel(isUnresolvedConflict, conflictKindLabel, t)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
        isUnresolvedConflict
          ? 'bg-destructive/12 text-destructive'
          : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
      )}
    >
      <Icon className="size-3" />
      <span>{label}</span>
    </span>
  )

  if (isUnresolvedConflict) {
    return badge
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {t(
            'auto.components.right.sidebar.SourceControl.03194cfff4',
            'Local session state derived from a conflict you opened here.'
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
