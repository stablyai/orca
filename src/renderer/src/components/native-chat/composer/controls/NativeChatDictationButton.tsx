import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** The composer's mic: a tap toggles dictation, or in hold mode it records while pressed. */
export function NativeChatDictationButton({
  disabled,
  isDictating,
  isHoldMode,
  onToggle,
  onHoldStart,
  onHoldEnd
}: {
  disabled: boolean
  isDictating: boolean
  isHoldMode: boolean
  onToggle: () => void
  onHoldStart: () => void
  onHoldEnd: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = isDictating
    ? t('components.native-chat.composer.stopDictation', 'Stop dictation')
    : t('components.native-chat.composer.startDictation', 'Start dictation')
  const holds = isHoldMode && !disabled
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={isDictating ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={isHoldMode ? undefined : onToggle}
          onPointerDown={(event) => {
            if (!holds) {
              return
            }
            event.preventDefault()
            onHoldStart()
          }}
          onPointerUp={() => {
            if (holds) {
              onHoldEnd()
            }
          }}
          onPointerCancel={() => {
            if (holds) {
              onHoldEnd()
            }
          }}
          onPointerLeave={(event) => {
            if (holds && event.buttons === 1) {
              onHoldEnd()
            }
          }}
          className="pointer-coarse:size-11"
        >
          {isDictating ? <Square className="size-3.5 fill-current" /> : <Mic className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
