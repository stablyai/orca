import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RecoveryPointDto } from '../../../../shared/data-recovery'
import { DataRecoveryPinExitCustomAgentExample } from './DataRecoveryPinExitCustomAgentExample'
import {
  dismissPinExitNotice,
  isPinExitNoticeDismissed
} from './data-recovery-pin-exit-notice-dismissal'

/** Only a pin that can actually be restored: an unreadable one would send people
 *  to a downgrade they cannot perform. `restorable` is optional (older hosts omit
 *  it), so only an explicit false withdraws the dialog. */
function restorablePreV1Point(points: RecoveryPointDto[]): RecoveryPointDto | null {
  return (
    points.find((point) => point.id === 'agent-catalog-pre-v1' && point.restorable !== false) ??
    null
  )
}

/** One-shot dialog after a successful agent-catalog pin. Most people should
 *  continue; the optional path is how to return to the previous Orca without
 *  reinstalling over live data. Hidden when migration is blocked (red notice
 *  owns that state), when no restorable pin exists, on paired web, or after
 *  dismiss for this pin. */
export function DataRecoveryPinExitNotice() {
  const [pin, setPin] = useState<RecoveryPointDto | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const continueRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async () => {
    try {
      const status = await window.api.dataRecovery?.migrationStatus()
      if (status?.agentCatalogMigrationError != null) {
        setPin(null)
        return
      }
      const points = (await window.api.dataRecovery?.listPoints()) ?? []
      const next = restorablePreV1Point(points)
      setPin(next)
      setDismissed(next != null && isPinExitNoticeDismissed(next.createdAtMs))
    } catch {
      setPin(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleDismiss = (): void => {
    if (pin !== null) {
      dismissPinExitNotice(pin.createdAtMs)
    }
    setDismissed(true)
  }

  const pinDialogOpen = pin !== null && !dismissed
  if (!pinDialogOpen) {
    return null
  }

  return (
    <Dialog
      open={pinDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleDismiss()
        }
      }}
    >
      <DialogContent
        className="max-w-lg gap-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          continueRef.current?.focus()
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-snug">
            {translate(
              'auto.components.dataRecovery.pinExitTitle',
              'Custom agents are now available'
            )}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-foreground">
            {translate(
              'auto.components.dataRecovery.pinExitLead',
              'Save a Codex, Claude, or other agent command under a name, then pick it from the agent list.'
            )}
          </DialogDescription>
        </DialogHeader>

        <DataRecoveryPinExitCustomAgentExample />
        <p className="text-sm leading-relaxed text-muted-foreground">
          {translate('auto.components.dataRecovery.pinExitExampleHintPrefix', 'Create them in')}{' '}
          <strong className="font-semibold text-foreground">
            {translate('auto.components.dataRecovery.settingsAgents', 'Settings → Agents')}
          </strong>
          .{' '}
          {translate(
            'auto.components.dataRecovery.pinExitExampleHintSuffix',
            'Keep working as usual — nothing else is required.'
          )}
        </p>

        <Separator />

        <Collapsible
          open={rollbackOpen}
          onOpenChange={setRollbackOpen}
          className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-between text-left font-medium text-foreground outline-none hover:text-foreground/80 focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span>
                {translate(
                  'auto.components.dataRecovery.pinExitRollbackTitle',
                  'If you need to downgrade to a previous Orca version later'
                )}
              </span>
              <ChevronDown
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  rollbackOpen && 'rotate-180'
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="collapsible-height-content space-y-1.5 pt-2">
            <p className="leading-relaxed">
              {translate(
                'auto.components.dataRecovery.pinExitRollbackReinstallPrefix',
                'This version updated some Orca entity schema. If you ever need to install an older Orca release, restore the backup from'
              )}{' '}
              <strong className="font-semibold text-foreground">
                {translate('auto.components.dataRecovery.settingsAgents', 'Settings → Agents')}
              </strong>{' '}
              {translate(
                'auto.components.dataRecovery.pinExitRollbackReinstallSuffix',
                'first so older versions can read your Orca config.'
              )}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              {translate(
                'auto.components.dataRecovery.pinExitRollbackLoss',
                'Restoring discards changes saved since this update, including custom agents.'
              )}
            </p>
          </CollapsibleContent>
        </Collapsible>

        <DialogFooter>
          <Button ref={continueRef} type="button" onClick={handleDismiss}>
            {translate('auto.components.dataRecovery.dismissPinExit', 'Continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
