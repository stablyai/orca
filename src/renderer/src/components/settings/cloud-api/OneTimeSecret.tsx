import { useId } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { CopyValueButton } from './cloud-api-parts'

/**
 * The one shared "shown once" moment for API keys, webhook URLs and approval codes: the same
 * warning, the whole value visible (wrapped, never clipped), and one Copy button.
 */
export function OneTimeSecret({
  label,
  value,
  copyLabel,
  warningTitle,
  warningBody,
  onCopied,
  footnote,
  expired = false
}: {
  label: string
  value: string
  copyLabel: string
  warningTitle: string
  warningBody: string
  onCopied?: () => void
  /** e.g. a live countdown (not live-announced: it ticks every second). */
  footnote?: React.ReactNode
  expired?: boolean
}): React.JSX.Element {
  const ids = useId()
  return (
    <div className="grid gap-3">
      <div
        role="note"
        className="flex items-start gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2.5 text-xs leading-5 text-foreground"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
        <p>
          <span className="font-medium">{warningTitle}</span> {warningBody}
        </p>
      </div>
      <div className="grid gap-1.5">
        <p id={`${ids}-label`} className="text-xs font-medium">
          {label}
        </p>
        <div className="flex items-start gap-2">
          <code
            aria-labelledby={`${ids}-label`}
            tabIndex={0}
            className={cn(
              'min-h-9 flex-1 select-all rounded-md border border-input bg-muted/30 px-3 py-2 font-mono text-xs leading-5 break-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              expired && 'text-muted-foreground line-through'
            )}
          >
            {value}
          </code>
          {expired ? null : (
            <CopyValueButton
              value={value}
              variant="default"
              size="sm"
              label={copyLabel}
              onCopied={onCopied}
            />
          )}
        </div>
        {footnote ? <div className="text-xs text-muted-foreground">{footnote}</div> : null}
      </div>
    </div>
  )
}

/** "I've saved it" until something was copied, then "Done" — the only way out of a secret step. */
export function OneTimeSecretDoneButton({
  copied,
  onDone
}: {
  copied: boolean
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button type="button" size="sm" variant={copied ? 'default' : 'outline'} onClick={onDone}>
      {copied
        ? t('auto.components.settings.cloudApi.secret.done', 'Done')
        : t('auto.components.settings.cloudApi.secret.doneUncopied', 'I’ve saved it')}
    </Button>
  )
}
