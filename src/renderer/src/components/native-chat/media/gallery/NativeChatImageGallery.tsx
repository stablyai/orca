import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatVisualOwnerContext } from '../visuals/native-chat-visual-owner'
import {
  nativeChatMarkdownImages,
  nativeChatVisualMarkdownImages
} from '../../markdown/native-chat-markdown-image-sources'
import {
  collectNativeChatGalleryImages,
  findNativeChatGalleryImage
} from './native-chat-gallery-images'
import { NativeChatImageGalleryContext } from './native-chat-image-gallery-context'
import { NativeChatImageGalleryDialog } from './NativeChatImageGalleryDialog'

type GallerySession = { id: number; key: string; open: boolean }

/** Lets every image trigger in a transcript open one preview that steps through the chat's images. */
export function NativeChatImageGalleryProvider({
  messages,
  children
}: {
  messages: readonly NativeChatMessage[]
  children: ReactNode
}): React.JSX.Element {
  const visualOwner = useContext(NativeChatVisualOwnerContext)
  // The same reader the transcript rows draw with, so the list matches what is on screen.
  const markdownImages = visualOwner ? nativeChatVisualMarkdownImages : nativeChatMarkdownImages
  const images = useMemo(
    () => collectNativeChatGalleryImages(messages, markdownImages),
    [messages, markdownImages]
  )
  const [session, setSession] = useState<GallerySession | null>(null)
  const openImage = useCallback(
    (source: string, messageId?: string) => {
      const image = findNativeChatGalleryImage(images, source, messageId)
      if (!image) {
        return false
      }
      setSession((current) => ({ id: (current?.id ?? 0) + 1, key: image.key, open: true }))
      return true
    },
    [images]
  )
  const gallery = useMemo(() => ({ open: openImage }), [openImage])
  // Keyed by image, so the preview stays on its image while new messages stream in.
  const index = session ? images.findIndex((image) => image.key === session.key) : -1

  return (
    <NativeChatImageGalleryContext.Provider value={gallery}>
      {children}
      {session && index >= 0 ? (
        <NativeChatImageGalleryDialog
          key={session.id}
          images={images}
          index={index}
          open={session.open}
          retryKey={session.id}
          onOpenChange={(open) => setSession((current) => current && { ...current, open })}
          onSelect={(key) => setSession((current) => current && { ...current, key })}
        />
      ) : null}
    </NativeChatImageGalleryContext.Provider>
  )
}
