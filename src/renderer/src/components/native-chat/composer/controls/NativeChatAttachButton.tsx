import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** The composer's + button: picks files to attach. */
export function NativeChatAttachButton({
  disabled,
  onAttach
}: {
  disabled?: boolean
  onAttach: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('components.native-chat.composer.attach', 'Attach file')}
          disabled={disabled}
          onClick={onAttach}
          className="pointer-coarse:size-11"
        >
          <Plus className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t('components.native-chat.composer.attach', 'Attach file')}
      </TooltipContent>
    </Tooltip>
  )
}
