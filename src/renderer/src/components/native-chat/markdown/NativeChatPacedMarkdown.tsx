import { memo, useRef, type ComponentProps } from 'react'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import { useKeptMathSelection } from './use-kept-math-selection'

/** A save the reveal takes in changes its state, not the text drawn yet; that renders no reply. */
const PacedMarkdownBody = memo(NativeChatMarkdown)

/** Isolate paced text updates so animation frames do not rerender the rest of the row. */
export function NativeChatPacedMarkdown({
  rowKey,
  content,
  streaming,
  savedRevision,
  renderSettledCodeBlock,
  ...props
}: Omit<
  ComponentProps<typeof NativeChatMarkdown>,
  'growing' | 'fadeFrom' | 'fadeHold' | 'fadeAnimates'
> & {
  rowKey: string
  streaming: boolean
  /** The row's saved journal revision, where it has one. */
  savedRevision?: number
  /** Replaces `renderCodeBlock` once the whole reply is drawn, so a block never acts on part of its text. */
  renderSettledCodeBlock?: ComponentProps<typeof NativeChatMarkdown>['renderCodeBlock']
}): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const paced = useNativeChatPacedText(rowKey, content, streaming, root, savedRevision)
  useKeptMathSelection(root, streaming || paced.revealing)
  const settled = !streaming && !paced.revealing && paced.text === content
  return (
    <PacedMarkdownBody
      {...props}
      {...(settled && renderSettledCodeBlock ? { renderCodeBlock: renderSettledCodeBlock } : {})}
      ref={root}
      rowKey={rowKey}
      content={paced.text}
      streaming={streaming || paced.revealing}
      fadeFrom={paced.fadeFrom}
      fadeHold={paced.fadeHold}
      fadeAnimates={paced.fadeAnimates}
    />
  )
}
