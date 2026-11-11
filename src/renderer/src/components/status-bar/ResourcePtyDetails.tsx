import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
  const fields = [
    [t('resourceManager.pty.sessionId', 'Orca session ID'), row.session.id],
    [t('resourceManager.pty.incarnation', 'Incarnation'), row.session.incarnationId || unavailable],
    [t('resourceManager.pty.workspace', 'Workspace'), row.workspace || unavailable],
    [t('resourceManager.pty.cwd', 'Last-reported cwd'), row.session.cwd || unavailable],
    [t('resourceManager.pty.binding', 'Tab'), resourcePtyBindingLabel(row.binding, t)],
    [t('resourceManager.pty.agentOwnership', 'Agent ownership evidence'), ownership],
    [
      t('resourceManager.pty.observationTime', 'Observation time'),
      observedAt === null ? unavailable : new Date(observedAt).toLocaleString(intlLocale)
    ],
    [t('resourceManager.pty.pid', 'PID'), row.session.rootProcessId?.toString() || unavailable]
  ]
  return (
    <div className="px-2.5 py-2">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all select-text">{value}</dd>
          </div>
        ))}
      </dl>
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void copySessionId()}>
        <Copy className="size-3.5" />
        {t('resourceManager.pty.copyId', 'Copy Orca session ID')}
      </Button>
    </div>
  )
}
