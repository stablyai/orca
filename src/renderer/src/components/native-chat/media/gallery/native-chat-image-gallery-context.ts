import { createContext } from 'react'

export type NativeChatImageGallery = {
  /** Opens the chat-wide preview on this image; false when it is not in the transcript. */
  open: (source: string, messageId?: string) => boolean
}

/** Present inside a transcript, so its image triggers can open one preview that steps through them all. */
export const NativeChatImageGalleryContext = createContext<NativeChatImageGallery | null>(null)
