import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { addressForPort } from '@/lib/workspace-port-urls'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { translate } from '@/i18n/i18n'

export function LocalPortDetailsDialog({
  port,
  onClose
}: {
  port: WorkspacePort | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={Boolean(port)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {port
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.472054d94c',
                  'Port :{{value0}}',
                  { value0: port.port }
                )
              : translate('auto.components.right.sidebar.PortsPanel.d41a8241ec', 'Port')}
          </DialogTitle>
          <DialogDescription>
            {port ? `${port.processName ?? 'Unknown process'} · ${addressForPort(port)}` : ''}
          </DialogDescription>
        </DialogHeader>
        {port && (
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.1c1c18cefc', 'Address')}
            </dt>
            <dd className="min-w-0 break-all text-foreground">{addressForPort(port)}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.0f1d8cd324', 'Bind')}
            </dt>
            <dd className="min-w-0 break-all text-foreground">{`${port.bindHost}:${port.port}`}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.729be0b4e5', 'Kind')}
            </dt>
            <dd className="text-foreground">{port.kind}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.b1ff94fa27', 'Protocol')}
            </dt>
            <dd className="text-foreground">{port.protocol}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.5dd86dcf2f', 'Process')}
            </dt>
            <dd className="min-w-0 break-all text-foreground">
              {port.processName ??
                translate('auto.components.right.sidebar.PortsPanel.3e13cb63ee', 'Unknown')}
            </dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.57d930fa45', 'PID')}
            </dt>
            <dd className="text-foreground">
              {port.pid ??
                translate('auto.components.right.sidebar.PortsPanel.3e13cb63ee', 'Unknown')}
            </dd>
            {port.kind === 'workspace' && (
              <>
                <dt className="text-muted-foreground">
                  {translate('auto.components.right.sidebar.PortsPanel.c7b4702b7b', 'Workspace')}
                </dt>
                <dd className="min-w-0 break-all text-foreground">{port.owner.displayName}</dd>
                <dt className="text-muted-foreground">
                  {translate('auto.components.right.sidebar.PortsPanel.153145e675', 'Evidence')}
                </dt>
                <dd className="text-foreground">{port.owner.confidence}</dd>
              </>
            )}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  )
}
