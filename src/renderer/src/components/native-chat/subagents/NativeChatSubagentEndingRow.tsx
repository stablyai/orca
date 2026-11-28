import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { NativeChatTextBlock } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import { NATIVE_CHAT_SUBAGENT_FAILURE_PRESENTATION } from './native-chat-subagent-ending'

/** A subagent's last word in its sheet: its reply under "Result", or its error under "Failed". */
export function NativeChatSubagentEndingRow({
  block,
  messageId
}: {
  block: NativeChatTextBlock
  messageId?: string
}): React.JSX.Element {
  const t = useTranslate()
  const failed = block.presentation === NATIVE_CHAT_SUBAGENT_FAILURE_PRESENTATION
  return (
    <section className="border-l-2 border-chat-composer-border py-0.5 pl-2.5">
      <h3
        className={cn(
          'mb-0.5 font-sans text-xs',
          failed ? 'text-destructive' : 'text-chat-foreground-faint'
        )}
      >
        {failed
          ? t('components.native-chat.subagents.stateHeading.failed', 'Failed')
          : t('components.native-chat.subagents.result', 'Result')}
      </h3>
      <NativeChatMarkdown
        rowKey={messageId === undefined ? undefined : `subagent-ending:${messageId}`}
        content={block.text}
        variant="document"
        renderCodeBlock={NativeChatCodeBlock}
        className="text-sm text-chat-foreground"
        linkifyFilePaths
      />
    </section>
  )
}
