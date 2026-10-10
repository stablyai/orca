import type { ComponentProps } from 'react'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'

/** The agent's prose, drawn at a reading pace while it is being written. Its own component so
 *  a frame of the pace re-renders the prose and nothing else in its row. */
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
      content={paced.text}
      streaming={streaming || paced.revealing}
      growing={paced.revealing}
      fadeWords={paced.fading}
    />
  )
}
