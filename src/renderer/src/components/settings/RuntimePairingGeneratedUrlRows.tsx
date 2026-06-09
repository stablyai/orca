import { Check, Copy } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

export function GeneratedUrlRow({
  label,
  description,
  value,
  copied,
  onCopy
}: {
  label: string
  description?: string
  value: string
  copied: boolean
  onCopy: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onCopy}
          aria-label={translate("auto.components.settings.RuntimePairingGeneratedUrlRows.0495f68959", "Copy {{value0}}", { value0: label })}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export function UnavailableUrlRow({
  label,
  description
}: {
  label: string
  description: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="rounded-md border border-border/60 px-2 py-1.5">
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
