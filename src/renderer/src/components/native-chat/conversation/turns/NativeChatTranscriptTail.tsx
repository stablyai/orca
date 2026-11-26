import { useTranslate } from '@/i18n/use-translate'
import {
  selectActiveToolCall,
  describeLatestToolCall
} from '../../../../../../shared/native-chat/tools/native-chat-tool-activity'
import { useNativeChatMessagingStyle } from '../../appearance/use-native-chat-messaging-style'
import type { NativeChatLiveLine } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-live-line'
import type { NativeChatTranscriptSlot } from '../slots/native-chat-transcript-slots'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import { NativeChatTurnActivityLine } from '../../messages/reasoning/NativeChatTurnActivityLine'
import { NativeChatAwaitingInputRow } from '../../prompts/NativeChatAwaitingInputRow'

export function NativeChatTranscriptTail({
  line,
  awaitingInput,
  context,
  slots,
  visible
}: {
  line: NativeChatLiveLine | null
  awaitingInput: boolean
  context: NativeChatTranscriptRowContext
  slots: readonly NativeChatTranscriptSlot[]
  visible: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const enabled = useNativeChatMessagingStyle()
  const messaging = enabled && context.turnBot != null
  const frontier = messaging
    ? slots.findLast(
        (slot) => slot.kind === 'message' && slot.activeTurnIsWorking && slot.drawsMessage
      )
    : undefined
  const block = frontier?.kind === 'message' ? frontier.message.blocks.at(-1) : undefined
  const replying =
    frontier?.kind === 'message' &&
    frontier.message.role === 'assistant' &&
    block?.type === 'text' &&
    block.text.trim().length > 0
  if (line && !replying) {
    const call =
      messaging && frontier?.kind === 'message'
        ? selectActiveToolCall(
            (frontier.workRun ?? [frontier.message]).flatMap((message) => message.blocks),
            { activeTurnIsWorking: true }
          )
        : null
    const currentLine =
      call && !line.activityText
        ? {
            ...line,
            activityText: t('components.native-chat.messaging.usingTool', 'Using {{tool}}', {
              tool: describeLatestToolCall(call)
            })
          }
        : line
    return (
      <NativeChatTurnActivityLine
        line={currentLine}
        context={context}
        messaging={messaging}
        visible={visible}
      />
    )
  }
  return awaitingInput ? <NativeChatAwaitingInputRow subject={null} pending /> : null
}
