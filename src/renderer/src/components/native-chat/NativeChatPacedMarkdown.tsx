import type { ComponentProps } from 'react'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'

/** Isolate paced text updates so animation frames do not rerender the rest of the row. */
export function NativeChatPacedMarkdown({
  rowKey,
  content,
  streaming,
  ...props
}: Omit<ComponentProps<typeof NativeChatMarkdown>, 'growing' | 'fadeWords'> & {
  rowKey: string
  streaming: boolean
}): React.JSX.Element {
  const paced = useNativeChatPacedText(rowKey, content, streaming)
  return (
    <NativeChatMarkdown
      {...props}
      rowKey={rowKey}
      content={paced.text}
      streaming={streaming || paced.revealing}
      growing={paced.revealing}
      fadeWords={paced.fading}
    />
  )
}
