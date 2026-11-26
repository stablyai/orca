import { Check, Clipboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** A published link with its Copy link button, as every share dialog shows it. */
export function ShareLinkCopyRow({
  url,
  onCopy
}: {
  url: string
  onCopy: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-3">
      <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <Check className="size-4" />
      </div>
      <p className="min-w-0 flex-1 truncate font-mono text-xs">{url}</p>
      <Button type="button" variant="outline" size="sm" onClick={onCopy}>
        <Clipboard className="size-4" />
        {t('auto.components.skills.SkillShareReviewContent.6d6233a3a4', 'Copy link')}
      </Button>
    </div>
  )
}
