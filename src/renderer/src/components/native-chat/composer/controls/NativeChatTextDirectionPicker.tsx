import { AlignLeft, AlignRight, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatPickerFocusReturn } from '../focus/native-chat-picker-focus-return'

export function NativeChatTextDirectionPicker({
  value,
  onChange,
  focusComposer
}: {
  value: 'auto' | 'ltr' | 'rtl'
  onChange: (value: 'auto' | 'ltr' | 'rtl') => void
  focusComposer?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { triggerRef, notePick, onInteractOutside, onCloseAutoFocus } =
    useNativeChatPickerFocusReturn(focusComposer)
  const labels = {
    auto: t('components.native-chat.textDirection.auto', 'Automatic'),
    rtl: t('components.native-chat.textDirection.rtl', 'Right to left'),
    ltr: t('components.native-chat.textDirection.ltr', 'Left to right')
  }
  const label = t('components.native-chat.textDirection.label', 'Text direction: {{direction}}', {
    direction: labels[value]
  })
  const Icon = value === 'rtl' ? AlignRight : value === 'ltr' ? AlignLeft : ArrowLeftRight
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
            >
              <Icon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        onInteractOutside={onInteractOutside}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === 'auto' || next === 'ltr' || next === 'rtl') {
              notePick()
              onChange(next)
            }
          }}
        >
          <DropdownMenuRadioItem value="auto">{labels.auto}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="rtl">{labels.rtl}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="ltr">{labels.ltr}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
