import type React from 'react'
import type { EphemeralVmRecipeDoctorResult } from '../../../../shared/ephemeral-vm-recipes'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function RecipeDoctorDialog({
  open,
  result,
  onOpenChange
}: {
  open: boolean
  result: EphemeralVmRecipeDoctorResult | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.EphemeralVmRecipeDialogs.recipeDoctor',
              'Recipe doctor'
            )}
          </DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-2">
            <div className="text-sm">
              {result.recipeId} ·{' '}
              {result.ok
                ? translate('auto.components.settings.EphemeralVmRecipeDialogs.ready', 'ready')
                : translate(
                    'auto.components.settings.EphemeralVmRecipeDialogs.needsAttention',
                    'needs attention'
                  )}
            </div>
            <div className="scrollbar-sleek max-h-80 space-y-2 overflow-auto">
              {result.checks.map((check) => (
                <div key={check.id} className="rounded-md border border-border/60 p-2">
                  <div
                    className={cn(
                      'text-xs font-medium',
                      check.status === 'fail' && 'text-destructive',
                      check.status === 'warn' && 'text-muted-foreground'
                    )}
                  >
                    {check.status.toUpperCase()} {check.id}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{check.message}</div>
                  {check.remediation ? (
                    <div className="mt-1 text-xs text-muted-foreground">{check.remediation}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
