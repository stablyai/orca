import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { ResourcePtyRow } from './resource-pty-view-model'

export function resourcePtyBindingLabel(binding: ResourcePtyRow['binding']): string {
  switch (binding) {
    case 'bound':
      return translate('resourceManager.pty.bound', 'Has tab')
    case 'unbound':
      return translate('resourceManager.pty.unbound', 'No tab')
    case 'pending':
      return translate('resourceManager.pty.checkingTabs', 'Checking tabs…')
  }
}

export function ResourcePtyDetails({
  row,
  observedAt
}: {
  row: ResourcePtyRow
  observedAt: number | null
}): React.JSX.Element {
  const copySessionId = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(row.session.id)
      toast.success(translate('resourceManager.pty.idCopied', 'Orca session ID copied'))
    } catch {
      toast.error(translate('resourceManager.pty.copyFailed', 'Could not copy Orca session ID'))
    }
  }
  const unavailable = translate('resourceManager.pty.unavailable', 'Unavailable')
  const ownership =
    row.session.agentOwnership === 'present'
      ? translate('resourceManager.pty.ownerPresent', 'Present')
      : row.session.agentOwnership === 'absent'
        ? translate('resourceManager.pty.ownerAbsent', 'Absent')
        : translate('resourceManager.pty.ownerUnknown', 'Unknown')
  const fields = [
    [translate('resourceManager.pty.sessionId', 'Orca session ID'), row.session.id],
    [
      translate('resourceManager.pty.incarnation', 'Incarnation'),
      row.session.incarnationId || unavailable
    ],
    [translate('resourceManager.pty.workspace', 'Workspace'), row.workspace || unavailable],
    [translate('resourceManager.pty.cwd', 'Last-reported cwd'), row.session.cwd || unavailable],
    [translate('resourceManager.pty.binding', 'Tab'), resourcePtyBindingLabel(row.binding)],
    [translate('resourceManager.pty.agentOwnership', 'Agent ownership evidence'), ownership],
    [
      translate('resourceManager.pty.observationTime', 'Observation time'),
      observedAt === null ? unavailable : new Date(observedAt).toLocaleString(getIntlLocale())
    ],
    [
      translate('resourceManager.pty.pid', 'PID'),
      row.session.rootProcessId?.toString() || unavailable
    ]
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
        {translate('resourceManager.pty.copyId', 'Copy Orca session ID')}
      </Button>
    </div>
  )
}
