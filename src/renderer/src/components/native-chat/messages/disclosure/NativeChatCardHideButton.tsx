import { EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { hideNativeChatCardKind } from './native-chat-card-kind-hidden-toast'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

/** Put on a hideable chat card's outer element so its Hide button reveals on card hover. */
export const NATIVE_CHAT_HIDEABLE_CARD_CLASS = 'group/chat-card'

/** The Hide icon at the end of a chat card's header, shown on card hover or keyboard focus. */
export function NativeChatCardHideButton({
  updates,
  settingSectionId,
  hiddenMessage,
  ariaLabel
}: {
  updates: Partial<GlobalSettings>
  settingSectionId: string
  hiddenMessage: string
  ariaLabel?: string
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.turnDiff.hide', 'Hide')
  return (
    // Keep the header one text line tall, as the transcript row-height estimate assumes.
    <span className="-my-1 ml-auto flex shrink-0 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/chat-card:pointer-events-auto group-hover/chat-card:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={ariaLabel ?? label}
            onClick={() => void hideNativeChatCardKind(updates, settingSectionId, hiddenMessage)}
          >
            <EyeOff aria-hidden className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
