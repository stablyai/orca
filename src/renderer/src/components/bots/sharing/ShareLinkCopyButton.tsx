// A share link's copy action: the copy icon alone (a check once copied), named by its tooltip.
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function ShareLinkCopyButton({
  onCopy,
  copied = false
}: {
  onCopy: () => void
  copied?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = copied ? t('bots.share.copied', 'Copied') : t('bots.share.copyLink', 'Copy link')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onCopy}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
