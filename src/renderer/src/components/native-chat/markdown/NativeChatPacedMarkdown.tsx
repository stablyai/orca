import { useEffect, useLayoutEffect, useReducer, useRef, type ComponentProps } from 'react'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import { createNativeChatRedrawPaceHook } from '../../../../../shared/native-chat/transcript/row-content/use-native-chat-redraw-pace'

/** Style, layout and paint of the frame after a commit: from that frame's animation callback to
 *  a message posted there, which runs once the frame is drawn. */
function measureFrameRendering(done: (ms: number) => void): () => void {
  const channel = new MessageChannel()
  const frame = requestAnimationFrame(() => {
    const start = performance.now()
    channel.port1.onmessage = () => {
      channel.port1.close()
      done(performance.now() - start)
    }
    channel.port2.postMessage(null)
  })
  return () => {
    cancelAnimationFrame(frame)
    channel.port1.close()
  }
}

const useNativeChatRedrawPace = createNativeChatRedrawPaceHook(
  { useEffect, useLayoutEffect, useReducer, useRef },
  measureFrameRendering
)

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
