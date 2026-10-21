import { Info, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { translate } from '@/i18n/i18n'

// Up to ten names show in full; a longer list shows the first eight and a count.
const MAX_FULL_TARGET_LABELS = 10
const COLLAPSED_TARGET_LABELS = 8

type SshDestructiveActionDialogProps = {
  open: boolean
  title: string
  description: string
  targetLabel?: string
  /** Several names, one per line; long lists collapse past the first few. */
  targetLabels?: readonly string[]
  notice?: string
  actionLabel: string
  busyLabel?: string
  isBusy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

export function SshDestructiveActionDialog({
  open,
  title,
  description,
  targetLabel,
  targetLabels,
  notice,
  actionLabel,
  busyLabel,
  isBusy = false,
  onOpenChange,
  onConfirm
}: SshDestructiveActionDialogProps): React.JSX.Element {
  const labels = targetLabels ?? []
  const shownLabels =
    labels.length > MAX_FULL_TARGET_LABELS ? labels.slice(0, COLLAPSED_TARGET_LABELS) : labels
  const hiddenLabelCount = labels.length - shownLabels.length
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isBusy && !nextOpen) {
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {targetLabel ? (
          <div className="scrollbar-sleek max-h-32 overflow-y-auto rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-words text-muted-foreground">{targetLabel}</div>
          </div>
        ) : null}

        {shownLabels.length > 0 ? (
          <ul className="scrollbar-sleek max-h-56 overflow-y-auto rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            {shownLabels.map((label, index) => (
              <li key={`${index}:${label}`} className="break-words py-0.5">
                {label}
              </li>
            ))}
            {hiddenLabelCount > 0 ? (
              <li className="py-0.5">
                {translate(
                  'auto.components.settings.SshDestructiveActionDialog.moreTargets',
                  '+{{count}} more',
                  { count: hiddenLabelCount }
                )}
              </li>
            ) : null}
          </ul>
        ) : null}

        {notice ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" />
            {notice}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            {translate('auto.components.settings.SshDestructiveActionDialog.895b216267', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isBusy} className="gap-1.5">
            {isBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {isBusy ? (busyLabel ?? actionLabel) : actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
