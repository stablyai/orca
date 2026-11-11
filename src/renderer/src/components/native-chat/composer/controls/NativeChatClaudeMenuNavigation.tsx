import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
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
      position: 'pointer-coarse:col-start-2 pointer-coarse:row-start-1',
      label: t('components.native-chat.commands.previous', 'Previous')
    },
    {
      key: '\x1b[B',
      icon: ArrowDown,
      position: 'pointer-coarse:col-start-2 pointer-coarse:row-start-3',
      label: t('components.native-chat.commands.next', 'Next')
    },
    {
      key: '\x1b[D',
      icon: ArrowLeft,
      position: 'pointer-coarse:col-start-1 pointer-coarse:row-start-2',
      label: t('components.native-chat.commands.left', 'Left')
    },
    {
      key: '\x1b[C',
      icon: ArrowRight,
      position: 'pointer-coarse:col-start-3 pointer-coarse:row-start-2',
      label: t('components.native-chat.commands.right', 'Right')
    }
  ]
  return (
    <div
      className="flex flex-wrap items-center gap-1 pointer-coarse:grid pointer-coarse:grid-cols-3"
      role="group"
      aria-label={t('components.native-chat.commands.navigation', 'Menu navigation')}
    >
      {directions.map(({ key, icon: Icon, position, label }) => (
        <div key={key} className={position}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="pointer-coarse:h-11 pointer-coarse:w-full"
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
        className="pointer-coarse:col-start-2 pointer-coarse:row-start-2 pointer-coarse:min-h-11"
        aria-label={t('components.native-chat.commands.select', 'Select')}
        disabled={disabled}
        onClick={() => onPress('\r')}
      >
        {t('components.native-chat.commands.select', 'Select')}
        <span aria-hidden className="pointer-coarse:hidden">
          <ShortcutKeyCombo
            keys={['Enter']}
            keyCapClassName="border-current/20 bg-transparent text-inherit shadow-none"
          />
        </span>
      </Button>
    </div>
  )
}
