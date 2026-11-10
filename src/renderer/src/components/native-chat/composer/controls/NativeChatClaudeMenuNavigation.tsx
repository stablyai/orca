import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function NativeChatClaudeMenuNavigation({
  disabled,
  onPress
}: {
  disabled: boolean
  onPress: (key: string) => void
}) {
  const t = useTranslate()
  const directions = [
    {
      key: '\x1b[A',
      icon: ArrowUp,
      position: 'col-start-2 row-start-1',
      label: t('components.native-chat.commands.previous', 'Previous')
    },
    {
      key: '\x1b[D',
      icon: ArrowLeft,
      position: 'col-start-1 row-start-2',
      label: t('components.native-chat.commands.left', 'Left')
    },
    {
      key: '\x1b[C',
      icon: ArrowRight,
      position: 'col-start-3 row-start-2',
      label: t('components.native-chat.commands.right', 'Right')
    },
    {
      key: '\x1b[B',
      icon: ArrowDown,
      position: 'col-start-2 row-start-3',
      label: t('components.native-chat.commands.next', 'Next')
    }
  ]
  return (
    <div
      className="grid grid-cols-3 gap-1"
      role="group"
      aria-label={t('components.native-chat.commands.navigation', 'Menu navigation')}
    >
      {directions.map(({ key, icon: Icon, position, label }) => (
        <div key={key} className={position}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-full pointer-coarse:min-h-11"
                disabled={disabled}
                aria-label={label}
                onClick={() => onPress(key)}
              >
                <Icon aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        </div>
      ))}
      <Button
        size="sm"
        className="col-start-2 row-start-2 h-9 pointer-coarse:min-h-11"
        disabled={disabled}
        onClick={() => onPress('\r')}
      >
        {t('components.native-chat.commands.select', 'Select')}
      </Button>
    </div>
  )
}
