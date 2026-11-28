// The words of something the person said in the chat: their prompts, and their comments on items.
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import { NativeChatUserMessageFold } from './NativeChatUserMessageFold'

export function NativeChatUserMessageBody({
  messageId,
  markdown,
  drawnMarkdown,
  structuredAttachments = false,
  runtimeContext,
  onRefolded
}: {
  messageId: string
  markdown: string
  /** A Slack message's drawn form; copy and folding keep `markdown`. */
  drawnMarkdown?: string
  structuredAttachments?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  onRefolded?: () => void
}): React.JSX.Element {
  return (
    <NativeChatUserMessageFold
      messageId={messageId}
      markdown={markdown}
      onRefolded={onRefolded}
      // List numbers hang into the bubble's padding; clipping at the text edge cut them off.
      className="-mx-3.5 px-3.5"
    >
      <NativeChatTextAttachments
        content={drawnMarkdown ?? markdown}
        structured={structuredAttachments}
        runtimeContext={runtimeContext}
        renderText={(text) => (
          <NativeChatMarkdown
            rowKey={messageId}
            content={text}
            variant="document"
            slackMentions={drawnMarkdown !== undefined}
            className="text-sm"
            renderCodeBlock={NativeChatCodeBlock}
          />
        )}
      />
    </NativeChatUserMessageFold>
  )
}
