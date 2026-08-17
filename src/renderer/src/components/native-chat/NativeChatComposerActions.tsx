import { Mic, Plus, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComposerRunButton } from '@/components/ComposerRunButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import { AgentSessionControls } from '../agent-session-controls/AgentSessionControls'

export type NativeChatComposerActionsProps = {
  attachDisabled: boolean
  dictationDisabled: boolean
  sendDisabled: boolean
  isWorking: boolean
  sendWhileWorking?: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  context?: AgentSessionContextSnapshot
  canCompact?: boolean
  onCompact?: () => Promise<void>
}

export function NativeChatComposerActions({
  attachDisabled,
  dictationDisabled,
  sendDisabled,
  isWorking,
  sendWhileWorking = false,
  isDictating,
  isDictationHoldMode,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest,
  context = EMPTY_AGENT_SESSION_CONTEXT,
  canCompact = false,
  onCompact
}: NativeChatComposerActionsProps): React.JSX.Element {
  const handleCriticalAction = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // A double-click commonly lands after the first send has started and the button has
    // changed to Stop; ignore the second click instead of cancelling the new turn.
    if (event.detail > 1) {
      return
    }
    if (isWorking && !sendWhileWorking) {
      onStop?.()
    } else {
      onSend()
    }
  }
  const stopMode = isWorking && !sendWhileWorking
  const dictationLabel = isDictating
    ? translate('components.native-chat.composer.stopDictation', 'Stop dictation')
    : translate('components.native-chat.composer.startDictation', 'Start dictation')
  return (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate('components.native-chat.composer.attach', 'Attach file')}
              disabled={attachDisabled}
              onClick={onAttach}
              className="pointer-coarse:size-11"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.native-chat.composer.attach', 'Attach file')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {/* Why: keep session controls beside the actions they affect; the
        model trigger is ordered last so it sits directly next to dictation. */}
        <AgentSessionControls
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          isWorking={isWorking}
          pickerRequest={sessionOptionsPickerRequest}
          context={context}
          canCompact={canCompact}
          onCompact={onCompact}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={isDictating ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={dictationLabel}
              disabled={dictationDisabled}
              onClick={isDictationHoldMode ? undefined : onDictationToggle}
              onPointerDown={(event) => {
                if (!isDictationHoldMode || dictationDisabled) {
                  return
                }
                event.preventDefault()
                onDictationHoldStart()
              }}
              onPointerUp={() => {
                if (isDictationHoldMode && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              onPointerCancel={() => {
                if (isDictationHoldMode && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              onPointerLeave={(event) => {
                if (isDictationHoldMode && event.buttons === 1 && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              className="pointer-coarse:size-11"
            >
              {isDictating ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {dictationLabel}
          </TooltipContent>
        </Tooltip>
        <ComposerRunButton
          mode={stopMode ? 'stop' : 'send'}
          label={
            stopMode
              ? translate('components.native-chat.stop', 'Stop the agent')
              : isWorking
                ? translate('components.native-chat.queue.add', 'Add to queue')
                : translate('components.native-chat.composer.send', 'Send')
          }
          disabled={sendDisabled}
          onClick={handleCriticalAction}
        />
      </div>
    </div>
  )
}
