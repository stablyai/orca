import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'
import {
  formatToolInput,
  MAX_TOOL_DETAIL_LENGTH,
  truncateToolDetail
} from '../../../../shared/native-chat/tools/native-chat-tool-summary'
import { NativeChatCopyButton } from './NativeChatCopyButton'

export function NativeChatToolInvocation({
  call
}: {
  call: NativeChatToolCallBlock
}): React.JSX.Element {
  const input = useMemo(() => formatToolInput(call.input), [call.input])
  const [expanded, setExpanded] = useState(false)
  const available = call.input !== null && call.input !== undefined
  return (
    <div data-native-chat-tool-invocation className="space-y-1">
      <p className="whitespace-pre-wrap break-all font-mono text-xs text-chat-foreground">
        {call.name}
      </p>
      {call.mcpIdentity ? (
        <p className="whitespace-pre-wrap break-all font-mono text-xs text-chat-foreground-faint">
          {call.mcpIdentity.server} / {call.mcpIdentity.tool}
        </p>
      ) : null}
      {available ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-chat-foreground-faint">
              {translate('components.native-chat.tool.input', 'Input')}
            </span>
            <NativeChatCopyButton
              text={input}
              label={translate('components.native-chat.tool.copyInput', 'Copy input')}
            />
          </div>
          <pre
            data-native-chat-code-content
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-chat-code text-chat-foreground scrollbar-sleek"
          >
            {expanded ? input : truncateToolDetail(input)}
          </pre>
          {!expanded && input.length > MAX_TOOL_DETAIL_LENGTH ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded(true)}>
              {translate('components.native-chat.tool.showFullInput', 'Show full input')}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-chat-foreground-faint">
          {translate(
            'components.native-chat.tool.inputUnavailable',
            'Input is not available in this transcript.'
          )}
        </p>
      )}
    </div>
  )
}
