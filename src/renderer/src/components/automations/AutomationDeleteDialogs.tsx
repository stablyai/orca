import React from 'react'
import { Check, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type {
  Automation,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import { getExternalAutomationScheduleDisplay } from './external-automation-schedule-display'
import { getExternalProviderLabel } from './external-automation-display'
import { translate } from '@/i18n/i18n'

export function AutomationDeleteDialog({
  deleteTarget,
  dontAskDeleteAgain,
  confirmButtonRef,
  onOpenChange,
  onDontAskAgainToggle,
  onCancel,
  onConfirm
}: {
  deleteTarget: Automation | null
  dontAskDeleteAgain: boolean
  confirmButtonRef: React.RefObject<HTMLButtonElement | null>
  onOpenChange: (open: boolean) => void
  onDontAskAgainToggle: () => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={deleteTarget !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.automations.AutomationsPage.080dcb5fbb',
              'Delete Automation'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}{' '}
            <span className="break-all font-medium text-foreground">{deleteTarget?.name}</span>{' '}
            {translate(
              'auto.components.automations.AutomationsPage.b264564427',
              'and its run history. Workspaces created by previous runs are not deleted.'
            )}
          </DialogDescription>
        </DialogHeader>
        {deleteTarget ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{deleteTarget.name}</div>
            <div className="mt-1 text-muted-foreground">
              {deleteTarget.workspaceMode === 'new_per_run'
                ? translate(
                    'auto.components.automations.AutomationsPage.cd8397cc32',
                    'New workspace each run'
                  )
                : translate(
                    'auto.components.automations.AutomationsPage.36f71740a7',
                    'Selected workspace'
                  )}
            </div>
          </div>
        ) : null}
        <button
          type="button"
          role="checkbox"
          aria-checked={dontAskDeleteAgain}
          onClick={onDontAskAgainToggle}
          className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
              dontAskDeleteAgain
                ? 'border-foreground bg-foreground text-background'
                : 'border-muted-foreground bg-transparent'
            }`}
          >
            {dontAskDeleteAgain ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          {translate('auto.components.automations.AutomationsPage.1e2e41392f', "Don't ask again")}
        </button>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {translate('auto.components.automations.AutomationsPage.73f630b49d', 'Cancel')}
          </Button>
          <Button ref={confirmButtonRef} variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ExternalAutomationDeleteDialog({
  externalDeleteTarget,
  confirmButtonRef,
  onOpenChange,
  onCancel,
  onConfirm
}: {
  externalDeleteTarget: {
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null
  confirmButtonRef: React.RefObject<HTMLButtonElement | null>
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={externalDeleteTarget !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.automations.AutomationsPage.9adfab2596',
              'Delete External Automation'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}{' '}
            <span className="break-all font-medium text-foreground">
              {externalDeleteTarget?.job.name}
            </span>{' '}
            {translate('auto.components.automations.AutomationsPage.02a33e3204', 'from')}{' '}
            {externalDeleteTarget
              ? getExternalProviderLabel(externalDeleteTarget.manager)
              : translate(
                  'auto.components.automations.AutomationsPage.8500baacb4',
                  'external source'
                )}{' '}
            {translate('auto.components.automations.AutomationsPage.1b586f0e2b', 'on')}{' '}
            {externalDeleteTarget?.manager.targetLabel}.
          </DialogDescription>
        </DialogHeader>
        {externalDeleteTarget ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">
              {externalDeleteTarget.job.name}
            </div>
            <div className="mt-1 text-muted-foreground">
              {
                getExternalAutomationScheduleDisplay(
                  externalDeleteTarget.manager,
                  externalDeleteTarget.job
                ).label
              }
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {translate('auto.components.automations.AutomationsPage.73f630b49d', 'Cancel')}
          </Button>
          <Button ref={confirmButtonRef} variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
