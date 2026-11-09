import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { CloudApiErrorNotice } from './cloud-api-parts'

/** A destructive confirmation that stays open (with the error) when the action fails. */
export function CloudConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = true
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel: string
  /** Resolves to an error message, or null on success (the dialog then closes). */
  onConfirm: () => Promise<string | null>
  destructive?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (next: boolean): void => {
    if (busy) {
      return
    }
    if (!next) {
      setError(null)
    }
    onOpenChange(next)
  }
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failure = await onConfirm()
    setBusy(false)
    if (failure) {
      setError(failure)
      return
    }
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent size="compact" className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {error ? <CloudApiErrorNotice message={error} /> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => change(false)}
          >
            {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
