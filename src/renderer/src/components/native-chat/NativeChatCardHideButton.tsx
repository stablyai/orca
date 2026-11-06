import { EyeOff } from 'lucide-react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { i18n, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

/** Put on a hideable chat card's outer element so its Hide button reveals on card hover. */
export const NATIVE_CHAT_HIDEABLE_CARD_CLASS = 'group/chat-card'

function openCardSetting(sectionId: string): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'chat', repoId: null, sectionId })
}

function HiddenToastDescription({ sectionId }: { sectionId: string }): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={translate(
        'components.native-chat.cardHide.hiddenDescription',
        'You can change this anytime in <settings>Settings › Chat UI</settings>'
      )}
      components={{
        settings: (
          <button
            type="button"
            className="rounded-sm font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => openCardSetting(sectionId)}
          />
        )
      }}
    />
  )
}

/** Hiding turns the global setting off, so every chat drops the card; confirm only a saved change. */
async function hideCardKind(
  updates: Partial<GlobalSettings>,
  settingSectionId: string,
  failedMessage: string
): Promise<void> {
  try {
    await useAppStore.getState().updateSettingsOrThrow(updates)
  } catch {
    toast.error(failedMessage)
    return
  }
  toast(translate('components.native-chat.cardHide.hidden', 'Hidden'), {
    description: <HiddenToastDescription sectionId={settingSectionId} />
  })
}

/** The Hide icon at the end of a chat card's header, shown on card hover or keyboard focus. */
export function NativeChatCardHideButton({
  updates,
  settingSectionId,
  failedMessage
}: {
  updates: Partial<GlobalSettings>
  settingSectionId: string
  failedMessage: string
}): React.JSX.Element {
  const label = translate('components.native-chat.cardHide.hide', 'Hide')
  return (
    // Like the transcript's other row actions. The negative margin keeps the header one text line
    // tall, as the row-height estimate assumes.
    <span className="-my-1 ml-auto flex shrink-0 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/chat-card:pointer-events-auto group-hover/chat-card:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={() => void hideCardKind(updates, settingSectionId, failedMessage)}
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
