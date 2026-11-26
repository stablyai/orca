import { Settings } from 'lucide-react'
import { useAppStore } from '../../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import {
  getChatWidthOptions,
  getChatMessageStyleOptions
} from '../../settings/appearance/chat/chat-appearance-search'
import { writeNativeChatAppearance } from './native-chat-appearance-write'

export function NativeChatSettingsButton(): React.JSX.Element {
  const t = useTranslate()
  const width = useAppStore((state) => state.settings?.nativeChatAppearance?.width ?? 'comfortable')
  const messageStyle = useAppStore(
    (state) => state.settings?.nativeChatAppearance?.messageStyle ?? 'default'
  )
  const label = t('components.native-chat.settings', 'Chat settings')

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="pane-title"
              size="icon-xs"
              aria-label={label}
              onClick={(event) => event.stopPropagation()}
            >
              <Settings className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuLabel>{t('settings.appearance.chat.width', 'Width')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={width}>
          {getChatWidthOptions(t).map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={() => {
                void writeNativeChatAppearance((current) => ({ ...current, width: option.value }))
              }}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {t('settings.appearance.chat.messageStyle', 'Message style')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={messageStyle}>
          {getChatMessageStyleOptions(t).map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={() => {
                void writeNativeChatAppearance((current) => ({
                  ...current,
                  messageStyle: option.value
                }))
              }}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
