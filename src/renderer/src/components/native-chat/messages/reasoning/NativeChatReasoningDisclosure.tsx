import { ChevronRight } from 'lucide-react'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatPacedMarkdown } from '../../markdown/NativeChatPacedMarkdown'

/** Bound reasoning height so expanded streaming output cannot grow the transcript indefinitely. */
export function NativeChatReasoningBody({
  markdown,
  rowKey,
  streaming = false,
  savedRevision
}: {
  markdown: string
  /** The reasoning block's disclosure key, shared by its live line and finished row. */
  rowKey?: string
  /** The block is still arriving under the live activity line. */
  streaming?: boolean
  /** The reasoning row's saved journal revision, while it streams. */
  savedRevision?: number
}): React.JSX.Element {
  const markdownProps = {
    variant: 'document' as const,
    className: 'text-sm',
    renderCodeBlock: NativeChatCodeBlock,
    linkifyFilePaths: true
  }
  return (
    <div
      data-native-chat-message-tone="faint"
      className="scrollbar-sleek mt-1 max-h-80 overflow-y-auto pl-5.5 text-chat-foreground-faint"
    >
      {/* Reasoning steps on the reveal clock, so a slow-to-draw block backs off as replies do; it
          stays mounted as it ends, keeping a reader's selection. */}
      {rowKey !== undefined ? (
        <NativeChatPacedMarkdown
          {...markdownProps}
          rowKey={rowKey}
          content={markdown}
          streaming={streaming}
          savedRevision={savedRevision}
        />
      ) : (
        <NativeChatMarkdown {...markdownProps} content={markdown} streaming={streaming} />
      )}
    </div>
  )
}

export function NativeChatReasoningChevron(): React.JSX.Element {
  return (
    <ChevronRight
      aria-hidden
      className="size-3.5 shrink-0 text-chat-foreground-faint transition-all can-hover:opacity-0 group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100 [[class~='group/reasoning']:has(:focus-visible)_&]:opacity-100 group-data-[state=open]/reasoning:rotate-90 group-data-[state=open]/reasoning:opacity-100 motion-reduce:transition-none"
    />
  )
}
