import { useContext } from 'react'
import type { Element } from 'hast'
import { NativeChatMarkdownImageOriginContext } from '../../markdown/native-chat-markdown-image-origin-context'
import { NativeChatDeferredMarkdownImage } from './NativeChatDeferredMarkdownImage'

export function NativeChatProvenancedMarkdownImage({
  src,
  alt,
  node
}: {
  src?: string
  alt?: string
  node?: Element
}): React.JSX.Element {
  const origins = useContext(NativeChatMarkdownImageOriginContext)
  return (
    <NativeChatDeferredMarkdownImage
      src={src}
      alt={alt}
      origin={node ? origins?.get(node) : undefined}
    />
  )
}
