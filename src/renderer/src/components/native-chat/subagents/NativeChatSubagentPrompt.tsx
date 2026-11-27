import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import { NativeChatUserMessageFold } from '../messages/rows/NativeChatUserMessageFold'

/** Opens a subagent's view with the task the main agent gave it, folded to a short preview. */
export function NativeChatSubagentPrompt({
  agentId,
  prompt
}: {
  agentId: string
  prompt: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5">
      <h3 className="mb-1 font-sans text-xs text-muted-foreground">
        {t('components.native-chat.subagents.prompt', 'Prompt')}
      </h3>
      <NativeChatUserMessageFold
        messageId={`subagent-prompt:${agentId}`}
        markdown={prompt}
        className="-mx-3.5 px-3.5 text-sm"
        foldLines={3}
      >
        <NativeChatMarkdown
          rowKey={`subagent-prompt:${agentId}`}
          content={prompt}
          variant="document"
          className="text-sm text-chat-foreground-strong"
          renderCodeBlock={NativeChatCodeBlock}
        />
      </NativeChatUserMessageFold>
    </section>
  )
}
