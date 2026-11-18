import { useEffect, useLayoutEffect, useReducer, useRef, type ComponentProps } from 'react'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import { createNativeChatRedrawPaceHook } from '../../../../../shared/native-chat/transcript/row-content/use-native-chat-redraw-pace'

const useNativeChatRedrawPace = createNativeChatRedrawPaceHook({
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef
})

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
  const growing = streaming || paced.revealing
  const drawn = useNativeChatRedrawPace(paced.text, growing)
  return (
    <NativeChatMarkdown
      {...props}
      rowKey={rowKey}
      content={drawn}
      streaming={growing}
      fadeWords={paced.fading}
    />
  )
}
