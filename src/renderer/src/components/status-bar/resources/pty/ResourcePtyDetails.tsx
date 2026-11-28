import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type { ResourcePtyRow } from './resource-pty-view-model'

export function resourcePtyBindingLabel(
  binding: ResourcePtyRow['binding'],
  t: Translate = translate
): string {
  switch (binding) {
    case 'bound':
      return t('resourceManager.pty.bound', 'Has tab')
    case 'unbound':
      return t('resourceManager.pty.unbound', 'No tab')
    case 'pending':
      return t('resourceManager.pty.checkingTabs', 'Checking tabs…')
  }
}

export function ResourcePtyDetails({
  row,
  observedAt
}: {
  row: ResourcePtyRow
  observedAt: number | null
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const copySessionId = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(row.session.id)
      toast.success(t('resourceManager.pty.idCopied', 'Orca session ID copied'))
    } catch {
      toast.error(t('resourceManager.pty.copyFailed', 'Could not copy Orca session ID'))
    }
  }
  const unavailable = t('resourceManager.pty.unavailable', 'Unavailable')
  const ownership =
    row.session.agentOwnership === 'present'
      ? t('resourceManager.pty.ownerPresent', 'Present')
      : row.session.agentOwnership === 'absent'
        ? t('resourceManager.pty.ownerAbsent', 'Absent')
        : t('resourceManager.pty.ownerUnknown', 'Unknown')
  const copyLabel = t('resourceManager.pty.copyId', 'Copy Orca session ID')
  const fields: [label: string, value: string, mono: boolean][] = [
    [t('resourceManager.pty.workspace', 'Workspace'), row.workspace || unavailable, false],
    [t('resourceManager.pty.project', 'Project'), row.project || unavailable, false],
    [
      t('resourceManager.pty.process', 'Last seen process'),
      row.session.foregroundProcess?.trim() || unavailable,
      true
    ],
    [t('resourceManager.pty.binding', 'Tab'), resourcePtyBindingLabel(row.binding, t), false],
    [t('resourceManager.pty.cwd', 'Last-reported cwd'), row.session.cwd || unavailable, true],
    [
      t('resourceManager.pty.pid', 'PID'),
      row.session.rootProcessId?.toString() || unavailable,
      true
    ],
    [t('resourceManager.pty.agentOwnership', 'Agent ownership evidence'), ownership, false]
  ]
  const trailingFields: [label: string, value: string, mono: boolean][] = [
    [
      t('resourceManager.pty.incarnation', 'Incarnation'),
      row.session.incarnationId || unavailable,
      true
    ],
    [
      t('resourceManager.pty.observationTime', 'Observation time'),
      observedAt === null ? unavailable : new Date(observedAt).toLocaleString(intlLocale),
      false
    ]
  ]
  const renderField = ([label, value, mono]: [string, string, boolean]): React.JSX.Element => (
    <div key={label} className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('break-all select-text', mono && 'font-mono')}>{value}</dd>
    </div>
  )
  return (
    <div className="pt-1 pr-3 pb-2 pl-[26px]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-2xs">
        {fields.map(renderField)}
        <dt className="text-muted-foreground">
          {t('resourceManager.pty.sessionId', 'Orca session ID')}
        </dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 font-mono break-all select-text">{row.session.id}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-4 shrink-0"
                aria-label={copyLabel}
                onClick={() => void copySessionId()}
              >
                <Copy className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {copyLabel}
            </TooltipContent>
          </Tooltip>
        </dd>
        {trailingFields.map(renderField)}
      </dl>
    </div>
  )
}
