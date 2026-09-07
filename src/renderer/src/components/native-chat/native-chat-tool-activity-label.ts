import { translate } from '@/i18n/i18n'
import {
  describeActiveToolCall,
  NATIVE_CHAT_TOOL_ACTIVITY_COPY
} from '../../../../shared/native-chat-tool-activity'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

type ToolCall = Extract<NativeChatBlock, { type: 'tool-call' }>

export function nativeChatToolActivityLabel(call: ToolCall): string {
  const { key, toolName, preview } = describeActiveToolCall(call)
  const copy = NATIVE_CHAT_TOOL_ACTIVITY_COPY[key]
  return key === 'runningPreview'
    ? translate('components.native-chat.tool.runningPreview', copy, { preview })
    : key === 'runningCommand'
      ? translate('components.native-chat.tool.runningCommand', copy)
      : key === 'runningNamedPreview'
        ? translate('components.native-chat.tool.runningNamedPreview', copy, { toolName, preview })
        : translate('components.native-chat.tool.runningNamed', copy, { toolName })
}
