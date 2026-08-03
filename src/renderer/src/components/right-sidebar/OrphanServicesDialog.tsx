import React from 'react'
import { Ghost } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  resolveServiceStopRequest,
  type WorkspaceService,
  type WorkspaceServiceStopRequest
} from '../../../../shared/workspace-services'
import { ServiceRow, UNRESOLVED } from './ServiceRow'
import { translate } from '@/i18n/i18n'

/**
 * Orphans are listed across every project on purpose: a service whose workspace
 * was deleted has no project left to filter by, and it is the one thing the
 * project-scoped section structurally cannot show.
 */
export function OrphanServicesDialog({
  open,
  orphans,
  onOpenChange,
  onStop
}: {
  open: boolean
  orphans: WorkspaceService[]
  onOpenChange: (open: boolean) => void
  onStop: (request: WorkspaceServiceStopRequest, notifyAgent: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.right.sidebar.OrphanServicesDialog.fd6fc51253',
              'Orphaned services'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.right.sidebar.OrphanServicesDialog.3a780b6f13',
              'Still running after the directory they were started from was deleted. Listed across all projects.'
            )}
          </DialogDescription>
        </DialogHeader>
        {orphans.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-6 text-center text-muted-foreground">
            <Ghost size={28} className="opacity-50" />
            <p className="text-sm">
              {translate(
                'auto.components.right.sidebar.OrphanServicesDialog.67c7dc7c6f',
                'No orphaned services'
              )}
            </p>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto scrollbar-sleek">
            {orphans.map((service) => (
              <div key={service.id} className="border-b border-border/40 last:border-b-0">
                <ServiceRow
                  service={service}
                  showProject
                  onStop={onStop}
                  stopRequest={resolveServiceStopRequest(service, null)}
                />
                <div className="px-8 pb-1 text-[10px] text-muted-foreground/70">
                  {service.workingDir ?? UNRESOLVED}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
