// The Bots section's way into the Needs you inbox: an inbox icon with how many items need you across
// every bot, as their hosts count them (no item read until the inbox opens).
import { Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useBotsNeedingOwner } from '@/lib/bots-needing-owner'
import { useShortcutKeyDetails } from '@/lib/keyboard/useShortcutLabel'
import { openBotsNeedsYouInbox } from './needs-you-inbox-open'

/** Shown while the section lists a bot, and whenever a host counts Needs you items, listed or not. */
export function BotsNeedsYouInboxButton({
  sectionListsBots
}: {
  sectionListsBots: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { bots, total } = useBotsNeedingOwner()
  const shortcut = useShortcutKeyDetails('bots.needsYouInbox')
  const label = t('bots.needsYouInbox.open', 'Needs you inbox')
  if (!sectionListsBots && bots.length === 0) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="muted-field-icon"
          size={total > 0 ? 'xs' : 'icon-xs'}
          className="shrink-0"
          aria-label={
            total > 0
              ? t('bots.needsYouInbox.openCount', 'Needs you inbox ({{total}})', { total })
              : label
          }
          data-bots-needs-you-inbox=""
          onClick={openBotsNeedsYouInbox}
        >
          <Inbox className="size-3.5" strokeWidth={2.25} />
          {total > 0 ? <span className="text-2xs tabular-nums">{total}</span> : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut.keys.length > 0 ? <ShortcutKeyCombo {...shortcut} /> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
