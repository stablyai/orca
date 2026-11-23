import { Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** Up next's glyph: the bot row's count and the panel heading share it, so one teaches the other. */
export const UpNextIcon = Lightbulb

/** A bot row's new Up next suggestions; a click shows them. */
export function BotUpNextCount({
  count,
  onReveal
}: {
  count: number
  onReveal: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('bots.upNext.newSuggestions', '{{count}} new suggestions · click to see', {
    count,
    defaultValue_one: '{{count}} new suggestion · click to see'
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          // Its padding hangs past the line, as the fold toggle's does.
          className="-mx-1 -my-1 shrink-0"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation()
            onReveal()
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="flex items-center gap-0.5 font-normal tabular-nums text-muted-foreground">
            <UpNextIcon className="size-3" aria-hidden="true" />
            {count}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
