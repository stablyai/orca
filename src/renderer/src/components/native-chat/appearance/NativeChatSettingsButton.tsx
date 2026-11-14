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
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { getChatWidthOptions } from '../../settings/appearance/chat/chat-appearance-search'
import { writeNativeChatAppearance } from './native-chat-appearance-write'

export function NativeChatSettingsButton(): React.JSX.Element {
  const t = useTranslate()
  const width = useAppStore((state) => state.settings?.nativeChatAppearance?.width ?? 'comfortable')
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
