import { useRef, type ComponentProps } from 'react'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'

/** Isolate paced text updates so animation frames do not rerender the rest of the row. */
export function NativeChatPacedMarkdown({
  rowKey,
  content,
  streaming,
  ...props
}: Omit<
  ComponentProps<typeof NativeChatMarkdown>,
  'growing' | 'fadeFrom' | 'fadeHold' | 'fadeAnimates'
> & {
  rowKey: string
  streaming: boolean
}): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const paced = useNativeChatPacedText(rowKey, content, streaming, root)
  return (
    <NativeChatMarkdown
      {...props}
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
