import React, { useId } from 'react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type {
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../../shared/automations/external/external-automation'
import { getExternalAutomationScheduleDisplay } from '../external/external-automation-schedule-display'
import { getExternalProviderLabel } from '../external/external-automation-display'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

/** What the dialog names: an automation, with where its runs work when it knows (the Automations page). */
export type AutomationDeleteTarget = Pick<Automation, 'name'> &
  Partial<Pick<Automation, 'workspaceMode'>>

export function AutomationDeleteDialog({
  deleteTarget,
  dontAskDeleteAgain,
  confirmButtonRef,
  onOpenChange,
  onDontAskAgainToggle,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
  confirmDisabledReason
}: {
  deleteTarget: AutomationDeleteTarget | null
  dontAskDeleteAgain: boolean
  confirmButtonRef: React.RefObject<HTMLButtonElement | null>
  onOpenChange: (open: boolean) => void
  onDontAskAgainToggle: () => void
  onCancel: () => void
  onConfirm: () => void
  /** Where focus goes once it closes; Radix returns it to the opener otherwise. */
  onCloseAutoFocus?: (event: Event) => void
  /** Delete can't run now, and why (its host is offline); Cancel still closes. */
  confirmDisabledReason?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const reasonId = useId()
  const workspaceMode = deleteTarget?.workspaceMode
  const confirm = (
    <Button
      ref={confirmButtonRef}
      variant="destructive"
      disabled={Boolean(confirmDisabledReason)}
      aria-describedby={confirmDisabledReason ? reasonId : undefined}
      onClick={onConfirm}
    >
      <Trash2 className="size-4" />
      {t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
    </Button>
  )
  return (
    <Dialog open={deleteTarget !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle size="compact">{t('common.delete', 'Delete')}</DialogTitle>
          <DialogDescription className="text-xs">
            <Trans
              i18n={i18n}
              defaults={
                workspaceMode
                  ? t(
                      'auto.components.automations.AutomationsPage.deleteAutomationDescription',
                      'Delete <name/> and its run history. Workspaces created by previous runs are not deleted.'
                    )
                  : t('bots.automations.deleteDescription', 'Delete <name/> and its run history.')
              }
              components={{
                name: (
                  <span className="break-all font-medium text-foreground">
                    {deleteTarget?.name}
                  </span>
                )
              }}
            />
          </DialogDescription>
        </DialogHeader>
        {deleteTarget && workspaceMode ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{deleteTarget.name}</div>
            <div className="mt-1 text-muted-foreground">
              {workspaceMode === 'new_per_run'
                ? t(
                    'auto.components.automations.AutomationsPage.cd8397cc32',
                    'New workspace each run'
                  )
                : t('auto.components.automations.AutomationsPage.36f71740a7', 'Selected workspace')}
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
          {t('auto.components.automations.AutomationsPage.1e2e41392f', "Don't ask again")}
        </button>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('auto.components.automations.AutomationsPage.73f630b49d', 'Cancel')}
          </Button>
          {confirmDisabledReason ? (
            // A disabled button takes no pointer, so its wrapper shows why.
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-not-allowed">{confirm}</span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {confirmDisabledReason}
              </TooltipContent>
            </Tooltip>
          ) : (
            confirm
          )}
          {confirmDisabledReason ? (
            <span id={reasonId} hidden>
              {confirmDisabledReason}
            </span>
          ) : null}
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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
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
          <DialogTitle size="compact">{t('common.delete', 'Delete')}</DialogTitle>
          <DialogDescription className="text-xs">
            <Trans
              i18n={i18n}
              defaults={t(
                'auto.components.automations.AutomationsPage.deleteExternalAutomationDescription',
                'Delete <name/> from <provider/> on <host/>.'
              )}
              components={{
                name: (
                  <span className="break-all font-medium text-foreground">
                    {externalDeleteTarget?.job.name}
                  </span>
                ),
                provider: (
                  <>
                    {externalDeleteTarget
                      ? getExternalProviderLabel(externalDeleteTarget.manager)
                      : t(
                          'auto.components.automations.AutomationsPage.8500baacb4',
                          'external source'
                        )}
                  </>
                ),
                host: <>{externalDeleteTarget?.manager.targetLabel}</>
              }}
            />
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
                  externalDeleteTarget.job,
                  t,
                  intlLocale
                ).label
              }
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('auto.components.automations.AutomationsPage.73f630b49d', 'Cancel')}
          </Button>
          <Button ref={confirmButtonRef} variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            {t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
