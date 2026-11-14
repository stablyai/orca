import { useEffect, useRef, useState } from 'react'
import { basename } from '@/lib/path'
import { routeNativeChatHref } from '../../../../../../shared/native-chat/native-chat-href-routing'
import { NativeChatMarkdownImage } from './NativeChatMarkdownImage'
import { observeTranscriptVisibility } from './native-chat-image-visibility'

/**
 * A reply can name hundreds of images. Each preview is a full component (lightbox, actions, lease),
 * so mounting them all at once stalls the row; mount each one the first time it nears the viewport.
 * It then stays mounted, so an open preview never loses its trigger while the transcript moves.
 */
export function NativeChatDeferredMarkdownImage(props: {
  src?: string
  alt?: string
}): React.JSX.Element {
  const placeholderRef = useRef<HTMLSpanElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = placeholderRef.current
    if (!element) {
      return
    }
    return observeTranscriptVisibility(element, (nextNear) => {
      if (nextNear) {
        setNear(true)
      }
    })
  }, [])
  if (near) {
    return <NativeChatMarkdownImage {...props} />
  }
  const route = routeNativeChatHref(props.src)
  // Screen readers still meet the image by name before it mounts.
  const label = props.alt?.trim() || (route.kind === 'file' ? basename(route.pathText) : '')
  return (
    // Roughly a thumbnail's height, so content below moves little when previews mount.
    <span
      ref={placeholderRef}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className="my-3 block h-24"
    />
  )
}
