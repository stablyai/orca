import { memo } from 'react'
import type { JSX } from 'react'
import { MarkdownPreviewBody } from '@/components/editor/markdown-preview/render-tree/MarkdownPreviewBody'
import { cn } from '@/lib/class-names'
import { stripRoomToolBlocks } from './room-chat-transcript-model'
import { roomMessageUrlTransform } from './room-message-url-transform'

const EMPTY_COMPONENTS = {}

/** Reuses the app's sanitized markdown pipeline for agent replies. */
export const RoomMessageMarkdown = memo(function RoomMessageMarkdown(props: {
  content: string
  className?: string
}): JSX.Element {
  return (
    <div className={cn('markdown-body text-sm leading-relaxed', props.className)}>
      <MarkdownPreviewBody
        content={stripRoomToolBlocks(props.content)}
        components={EMPTY_COMPONENTS}
        urlTransform={roomMessageUrlTransform}
      />
    </div>
  )
})
