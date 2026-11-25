import type { ReactNode } from 'react'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { splitSentImagePromptMarkers } from '../../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'

export type NativeChatSentImage = Extract<NativeChatBlock, { type: 'image-ref' }>

/** A sent prompt's text with each image drawn where its `[Image #k]` marker was typed. */
export function NativeChatUserInlineImageText({
  text,
  images,
  runtimeContext,
  renderText
}: {
  text: string
  images: readonly NativeChatSentImage[]
  runtimeContext: RuntimeFileOperationArgs | null | undefined
  renderText: (text: string) => ReactNode
}): React.JSX.Element {
  // Keys are where a part starts in the text, which no other part shares.
  let offset = 0
  const parts = splitSentImagePromptMarkers(text, images.length).map((part) => {
    const key = offset
    offset += typeof part === 'string' ? part.length : `[Image #${part}]`.length
    return { part, key }
  })
  return (
    <>
      {parts.map(({ part, key }) => {
        if (typeof part === 'string') {
          return part.trim() ? <div key={key}>{renderText(part)}</div> : null
        }
        const image = images[part - 1]
        return image ? (
          <NativeChatImageAttachments
            key={key}
            blocks={[image]}
            viewerBlocks={images}
            runtimeContext={runtimeContext}
            enablePreview={runtimeContext !== undefined}
            className="my-2 first:mt-0 last:mb-0"
          />
        ) : null
      })}
    </>
  )
}
