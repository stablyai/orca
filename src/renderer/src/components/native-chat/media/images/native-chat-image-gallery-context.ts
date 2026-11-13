import { createContext, useContext } from 'react'
export const NativeChatImageGalleryRow = createContext('')
export const NativeChatImageGalleryContext = createContext<{
  open: (rowId: string, source: string, title: string, previewSrc?: string) => void
} | null>(null)
export function useNativeChatImageGallery(
  source: string | undefined,
  title: string,
  previewSrc?: string
): ((previewSrc?: string) => void) | undefined {
  const gallery = useContext(NativeChatImageGalleryContext)
  const row = useContext(NativeChatImageGalleryRow)
  return gallery && row && source
    ? (resolved) => gallery.open(row, source, title, resolved ?? previewSrc)
    : undefined
}
