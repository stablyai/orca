import { useMemo, useState } from 'react'
import { mcpToolIdentity } from '../../../../shared/native-chat/tools/native-chat-tool-identity'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  formatToolInput,
  MAX_TOOL_DETAIL_LENGTH,
  truncateToolDetail
} from '../../../../shared/native-chat/tools/native-chat-tool-summary'
import { NativeChatCopyButton } from './messages/actions/NativeChatCopyButton'

export function NativeChatToolInvocation({
  call
}: {
  call: NativeChatToolCallBlock
}): React.JSX.Element {
  const t = useTranslate()
  const input = useMemo(() => formatToolInput(call.input), [call.input])
  const [expanded, setExpanded] = useState(false)
  const available = call.input !== null && call.input !== undefined
  const identity = call.mcpIdentity ?? mcpToolIdentity(call.name)
  return (
    <div data-native-chat-tool-invocation className="space-y-1">
      <p className="whitespace-pre-wrap break-all font-mono text-xs text-chat-foreground">
        {call.name}
      </p>
      {identity ? (
        <p className="whitespace-pre-wrap break-all font-mono text-xs text-chat-foreground-faint">
          {identity.server} / {identity.tool}
        </p>
      ) : null}
      {available ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-chat-foreground-faint">
              {t('components.native-chat.tool.input', 'Input')}
            </span>
            <NativeChatCopyButton
              text={input}
              label={t('components.native-chat.tool.copyInput', 'Copy input')}
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
              {t('components.native-chat.tool.showFullInput', 'Show full input')}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-chat-foreground-faint">
          {t(
            'components.native-chat.tool.inputUnavailable',
            'Input is not available in this transcript.'
          )}
        </p>
      )}
    </div>
  )
}
