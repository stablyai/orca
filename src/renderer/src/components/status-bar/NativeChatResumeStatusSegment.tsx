import { RotateCcw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { requestNativeChatResumeOnRestartDialog } from '../native-chat-resume-on-restart-dialog'
import {
  refreshNativeChatRestartOffer,
  useNativeChatRestartOffer
} from '../native-chat-resume-on-restart-store'

// Why: closing the reconnect dialog is a snooze, not a decline — the host keeps the offer. This is
// then the only surface left carrying it, so it is always rendered rather than gated by
// `statusBarItems`.

/** Re-reads the host before opening: a chat recovered by simply being opened is already gone from
 *  the offer, and reopening on a cached count would offer it back and earn a refusal. */
async function reopenOffer(): Promise<void> {
  const offered = await refreshNativeChatRestartOffer()
  if (offered.length > 0) {
    requestNativeChatResumeOnRestartDialog()
  }
}

export function NativeChatResumeStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const structuredEnabled = useAppStore(
    (store) => store.settings?.experimentalStructuredNativeChat === true
  )
  const { candidates } = useNativeChatRestartOffer(structuredEnabled)
  if (!structuredEnabled || candidates.length === 0) {
    return null
  }

  const count = candidates.length
  const label =
    count === 1
      ? translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.labelOne',
          '1 chat to reconnect'
        )
      : translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.label',
          '{{value0}} chats to reconnect',
          { value0: count }
        )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void reopenOffer()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={
            count === 1
              ? translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelOne',
                  '1 chat available to reconnect'
                )
              : translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabel',
                  '{{value0}} chats available to reconnect',
                  { value0: count }
                )
          }
        >
          <RotateCcw className="size-3 text-muted-foreground" />
          <span className="text-[11px]">{iconOnly ? count : label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.tooltip',
          'Open interrupted chats available to reconnect'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
