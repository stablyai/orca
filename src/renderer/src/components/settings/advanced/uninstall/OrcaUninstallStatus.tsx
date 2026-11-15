import type React from 'react'
import { Check, CircleAlert, Copy, Loader2 } from 'lucide-react'
import type { OrcaUninstallEntryState } from '../../../../../../shared/uninstall/orca-uninstall-types'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { isOrcaUninstallProblem, isOrcaUninstallSettled } from './orca-uninstall-plan-state'

export type OrcaUninstallSlotKind = 'running' | 'ok' | 'problem' | 'blank'

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
  if (states.length > 0 && states.every(isOrcaUninstallSettled)) {
    return 'ok'
  }
  return 'blank'
}

/** The 14px right-hand status slot shared by rows and sub-rows, so icons line up down the card. */
export function OrcaUninstallStatusIcon({
  kind,
  detail
}: {
  kind: OrcaUninstallSlotKind
  /** The one-line reason, shown on hover for problem rows. */
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
  if (kind === 'problem') {
    const label = detail || t('settings.uninstall.status.problem', 'Needs attention')
    const icon = <CircleAlert aria-label={label} className="size-3.5 text-destructive" />
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

export function OrcaUninstallCopyCommandButton({
  command
}: {
  command: string
}): React.JSX.Element {
  const t = useTranslate()
  const { copyText, status } = useClipboardTextCopyFeedback(command)
  return (
    <Button variant="outline" size="xs" onClick={() => void copyText()}>
      {status === 'copied' ? <Check /> : <Copy />}
      {t('settings.uninstall.copyCommand', 'Copy command')}
    </Button>
  )
}
