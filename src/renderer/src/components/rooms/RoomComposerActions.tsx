import type { RefObject } from 'react'
import { Paperclip, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComposerRunButton, type ComposerRunMode } from '@/components/ComposerRunButton'
import { translate } from '@/i18n/i18n'
import { RoomDictationButton } from './RoomDictationButton'

export function RoomComposerActions({
  attachDisabled,
  onAttach,
  textareaRef,
  run
}: {
  attachDisabled: boolean
  onAttach: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  run: {
    mode: ComposerRunMode
    label: string
    disabled: boolean
    loading?: boolean
    invoke: () => void
  }
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onAttach}
        disabled={attachDisabled}
        aria-label={translate('rooms.composer.attachFile', 'Attach file')}
      >
        <Paperclip className="size-4" />
      </Button>
      <RoomDictationButton textareaRef={textareaRef} />
      <div className="flex-1" />
      <ComposerRunButton
        mode={run.mode}
        label={run.label}
        disabled={run.disabled}
        loading={run.loading}
        onClick={run.invoke}
        sendIcon={<Send className="size-4" />}
      />
    </div>
  )
}
