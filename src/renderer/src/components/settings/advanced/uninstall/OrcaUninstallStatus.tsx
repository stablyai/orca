import type React from 'react'
import { Check, CircleAlert, CircleMinus, Loader2 } from 'lucide-react'
import type { OrcaUninstallEntryState } from '../../../../../../shared/uninstall/orca-uninstall-types'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { isOrcaUninstallProblem } from './orca-uninstall-plan-state'

export type OrcaUninstallSlotKind = 'running' | 'ok' | 'kept' | 'problem' | 'blank'

export function getOrcaUninstallSlotKind(
  states: readonly OrcaUninstallEntryState[],
  running: boolean
): OrcaUninstallSlotKind {
  if (running) {
    return 'running'
  }
  if (states.some(isOrcaUninstallProblem)) {
    return 'problem'
  }
  // Green means gone from disk; anything kept reads neutral so it never passes for Done.
  if (states.length > 0 && states.every((state) => state === 'removed')) {
    return 'ok'
  }
  if (
    states.some((state) => state === 'kept-shared') &&
    states.every((state) => state !== 'present')
  ) {
    return 'kept'
  }
  return 'blank'
}

/** The 14px right-hand status slot shared by rows and sub-rows, so icons line up down the card. */
export function OrcaUninstallStatusIcon({
  kind,
  detail
}: {
  kind: OrcaUninstallSlotKind
  /** The one-line reason, shown on hover for problem and kept rows. */
  detail?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  if (kind === 'running') {
    return (
      <Loader2
        aria-label={t('settings.uninstall.status.running', 'Removing')}
        className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    )
  }
  if (kind === 'ok') {
    return (
      <Check
        aria-label={t('settings.uninstall.status.done', 'Done')}
        className="size-3.5 text-status-success"
      />
    )
  }
  if (kind === 'problem' || kind === 'kept') {
    const label =
      detail ||
      (kind === 'problem'
        ? t('settings.uninstall.status.problem', 'Needs attention')
        : t('settings.uninstall.status.kept', 'Kept'))
    const icon =
      kind === 'problem' ? (
        <CircleAlert aria-label={label} className="size-3.5 text-destructive" />
      ) : (
        <CircleMinus aria-label={label} className="size-3.5 text-muted-foreground" />
      )
    if (!detail) {
      return icon
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {icon}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {detail}
        </TooltipContent>
      </Tooltip>
    )
  }
  return <span className="size-3.5" />
}
